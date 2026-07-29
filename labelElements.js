// Injected into the page. Finds interactive elements, draws numbered
// overlays, and returns a compact text map the model can reason over.
// This replaces "ask the model to guess a CSS selector."

function labelInteractiveElements() {
  // clear any previous labels
  document.querySelectorAll('.agent-label-overlay').forEach(el => el.remove());

  const selector = [
    'a[href]', 'button', 'input', 'select', 'textarea',
    '[role="button"]', '[role="link"]', '[role="textbox"]',
    '[onclick]', '[contenteditable="true"]'
  ].join(',');

  const candidates = Array.from(document.querySelectorAll(selector));
  const map = [];
  let index = 0;

  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    const visible =
      rect.width > 0 &&
      rect.height > 0 &&
      rect.top >= 0 &&
      rect.left >= 0 &&
      rect.bottom <= window.innerHeight &&
      rect.right <= window.innerWidth &&
      getComputedStyle(el).visibility !== 'hidden' &&
      getComputedStyle(el).display !== 'none';

    if (!visible) continue;

    const id = index++;
    el.setAttribute('data-agent-id', id);

    const label = document.createElement('div');
    label.className = 'agent-label-overlay';
    label.textContent = id;
    label.style.cssText = `
      position: fixed;
      top: ${rect.top}px;
      left: ${rect.left}px;
      background: #ff3366;
      color: white;
      font-size: 11px;
      font-family: monospace;
      padding: 1px 4px;
      border-radius: 3px;
      z-index: 999999;
      pointer-events: none;
      line-height: 1.4;
    `;
    document.body.appendChild(label);

    const text =
      el.innerText?.trim().slice(0, 60) ||
      el.getAttribute('placeholder') ||
      el.getAttribute('aria-label') ||
      el.getAttribute('value') ||
      el.getAttribute('alt') ||
      '';

    map.push({
      id,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      text,
      role: el.getAttribute('role') || ''
    });
  }

  return map;
}

module.exports = { labelInteractiveElements };
