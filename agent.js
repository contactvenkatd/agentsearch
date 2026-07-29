require('dotenv').config();
const { chromium } = require('playwright');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { labelInteractiveElements } = require('./labelElements');

const grok = new OpenAI({
  apiKey: process.env.XAI_API_KEY,
  baseURL: 'https://api.x.ai/v1'
});

const USER_DATA_DIR = path.join(__dirname, 'chrome-profile');
const MAX_STEPS = 25;

function askUser(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'browser_action',
      description: 'Perform one action in the browser and observe the result.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['click', 'type', 'navigate', 'scroll', 'accept_autofill', 'request_purchase_confirmation', 'wait', 'done'],
            description:
              'click: click element by id. type: fill element by id with text. ' +
              'navigate: go to a url. scroll: scroll down one page. ' +
              'accept_autofill: click an element, then press the autofill suggestion that Chrome shows (use on checkout fields). ' +
              'request_purchase_confirmation: REQUIRED before clicking any final order-submit / place-order / pay-now / confirm-purchase button. ' +
              'Pauses and asks a human to approve. You must call this and receive approval before that click — never click a payment-submit button directly. ' +
              'wait: pause for page to settle. done: task is complete.'
          },
          element_id: { type: 'integer', description: 'The numbered id from the labeled element map. Required for click, type, accept_autofill.' },
          text: { type: 'string', description: 'Text to type. Required for type.' },
          url: { type: 'string', description: 'URL to navigate to. Required for navigate.' },
          summary: { type: 'string', description: 'Required for request_purchase_confirmation. Plain summary of what will be purchased: item, price, quantity, total.' },
          reasoning: { type: 'string', description: 'One sentence: why this action.' }
        },
        required: ['action', 'reasoning']
      }
    }
  }
];

async function getPageState(page) {
  const elements = await page.evaluate(labelInteractiveElements);
  const url = page.url();
  const title = await page.title().catch(() => '');
  return { elements, url, title };
}

function formatElementsForModel(elements) {
  if (elements.length === 0) return '(no interactive elements detected)';
  return elements
    .map(e => `[${e.id}] ${e.tag}${e.type ? `[type=${e.type}]` : ''}${e.role ? ` role=${e.role}` : ''} "${e.text}"`)
    .join('\n');
}

async function runAgent(task) {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    channel: 'chrome', // real Chrome, not bundled Chromium — needed for Google-synced autofill
    viewport: { width: 1280, height: 900 }
  });

  const page = context.pages()[0] || (await context.newPage());
  let messages = [];
  let step = 0;
  let paymentFieldTouched = false; // true once accept_autofill has run — payment info is now on the page
  let purchaseApproved = false;    // true only after human types "yes" at a confirmation prompt

  console.log(`\n[task] ${task}\n`);

  while (step < MAX_STEPS) {
    step++;
    const { elements, url, title } = await getPageState(page);
    const elementText = formatElementsForModel(elements);

    messages.push({
      role: 'user',
      content: `Task: ${task}

Current URL: ${url}
Page title: ${title}

Interactive elements on screen:
${elementText}

Decide the single next action. If the task is complete, use action "done".`
    });

    const response = await grok.chat.completions.create({
      model: 'grok-4-3',
      max_tokens: 1024,
      tools: TOOLS,
      tool_choice: { type: 'function', function: { name: 'browser_action' } },
      messages
    });

    const toolCall = response.choices[0]?.message?.tool_calls?.[0];
    if (!toolCall) {
      console.log('[agent] no tool call returned, stopping.');
      break;
    }

    const toolInput = JSON.parse(toolCall.function.arguments);
    const { action, element_id, text, url: navUrl, reasoning } = toolInput;
    console.log(`[step ${step}] ${action}${element_id !== undefined ? ` #${element_id}` : ''} — ${reasoning}`);

    messages.push(response.choices[0].message);

    let resultNote = 'ok';
    try {
      // Hard safety gate: once payment autofill has touched the page, no click
      // fires until a human has explicitly approved via request_purchase_confirmation.
      // This does not depend on the model choosing to ask — it blocks regardless.
      if (action === 'click' && paymentFieldTouched && !purchaseApproved) {
        resultNote = 'blocked: payment info has been entered but purchase is not yet confirmed. Call request_purchase_confirmation first.';
        console.log(`[step ${step}] BLOCKED — click attempted after autofill without confirmation.`);
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: `Action result: ${resultNote}` });
        await page.waitForTimeout(500);
        continue;
      }

      switch (action) {
        case 'navigate':
          await page.goto(navUrl, { waitUntil: 'domcontentloaded' });
          break;

        case 'click':
          await page.click(`[data-agent-id="${element_id}"]`, { timeout: 5000 });
          break;

        case 'type':
          await page.fill(`[data-agent-id="${element_id}"]`, text, { timeout: 5000 });
          break;

        case 'accept_autofill':
          // Click the field to trigger Chrome's autofill dropdown, then Down+Enter
          // to accept the first suggestion — same as a human would.
          await page.click(`[data-agent-id="${element_id}"]`, { timeout: 5000 });
          await page.waitForTimeout(400);
          await page.keyboard.press('ArrowDown');
          await page.keyboard.press('Enter');
          paymentFieldTouched = true;
          break;

        case 'request_purchase_confirmation': {
          const summary = toolInput.summary || '(no summary provided by agent)';
          console.log('\n' + '='.repeat(60));
          console.log('PURCHASE CONFIRMATION REQUIRED');
          console.log(summary);
          console.log('Current page:', page.url());
          console.log('='.repeat(60));
          const answer = await askUser('Approve this purchase? Type "yes" to confirm, anything else to cancel: ');
          if (answer === 'yes') {
            purchaseApproved = true;
            resultNote = 'human approved the purchase. You may now proceed to click the final submit/place-order button.';
            console.log('[confirmation] approved by user.\n');
          } else {
            purchaseApproved = false;
            resultNote = 'human did NOT approve. Do not click any submit/pay/place-order button. Stop or ask what to change.';
            console.log('[confirmation] declined by user.\n');
          }
          break;
        }

        case 'scroll':
          await page.mouse.wheel(0, 800);
          break;

        case 'wait':
          await page.waitForTimeout(1500);
          break;

        case 'done':
          console.log('\n[agent] task marked complete.\n');
          await context.close();
          return;
      }
    } catch (err) {
      resultNote = `error: ${err.message}`;
      console.log(`[step ${step}] action failed — ${resultNote}`);
    }

    messages.push({
      role: 'tool',
      tool_call_id: toolCall.id,
      content: `Action result: ${resultNote}`
    });

    await page.waitForTimeout(800);
  }

  console.log('\n[agent] hit max step limit, stopping.\n');
  await context.close();
}

const task = process.argv.slice(2).join(' ') || 'Go to example.com and describe what you see';
runAgent(task).catch(err => {
  console.error('[fatal]', err);
  process.exit(1);
});
