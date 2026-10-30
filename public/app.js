// Progressive enhancement: everything works without JS; this avoids page reloads.
document.addEventListener('submit', async (ev) => {
  const form = ev.target;
  if (form.matches('form[data-confirm]') && !confirm(form.dataset.confirm)) {
    ev.preventDefault();
    return;
  }
  if (form.matches('form.seen-form')) {
    ev.preventDefault();
    toggleSeen(form, ev.submitter ?? form.querySelector('button'));
    return;
  }
  if (!form.matches('form.feedback')) return;
  ev.preventDefault();
  const button = ev.submitter;
  if (!button) return;
  button.disabled = true;
  try {
    const res = await fetch(form.action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ type: button.value }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { state } = await res.json();
    render(form, state);
    if (form.classList.contains('story-save')) syncSaved(form, state);
    button.classList.remove('err');
  } catch (err) {
    const message = `Could not save feedback: ${err.message}`;
    if (form.classList.contains('feedback-compact')) showFeedbackHelp(button, message);
    else button.title = message;
    button.classList.add('err');
  } finally {
    button.disabled = false;
  }
});

// Story "seen" state. In a filtered list (unseen or seen only) a card that no longer matches leaves it.
async function toggleSeen(form, button) {
  button.disabled = true;
  try {
    const res = await fetch(`/stories/${form.dataset.story}/seen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ state: button.value }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { unseen, relevantNew } = await res.json();
    const tabCount = document.querySelector('[data-qv-count="relevant"]');
    if (tabCount) tabCount.textContent = relevantNew;
    const card = form.closest('article.card');
    const filter = document.querySelector('.list[data-seen-filter]')?.dataset.seenFilter;
    if (card && filter && (filter === 'unseen') !== unseen) removeCard(card, filter);
    else renderSeen(form, card, !unseen);
    button.classList.remove('err');
  } catch (err) {
    button.title = `Could not save: ${err.message}`;
    button.classList.add('err');
  } finally {
    button.disabled = false;
  }
}

function renderSeen(form, card, seen) {
  const b = form.querySelector('.seen-btn');
  b.value = seen ? 'unseen' : 'seen';
  b.classList.toggle('on', seen);
  b.setAttribute('aria-pressed', String(seen));
  b.title = seen ? 'Seen. Click to mark it as unseen.' : 'Mark as seen. It comes back as new if the story develops.';
  b.querySelector('.seen-label').textContent = seen ? 'Seen' : 'Mark seen';
  if (card) {
    card.classList.toggle('seen', seen);
    card.classList.toggle('unseen', !seen);
    if (seen) card.querySelector('[data-new-dev]')?.remove();
  }
}

function removeCard(card, filter) {
  const list = card.parentElement;
  const next = card.nextElementSibling ?? card.previousElementSibling;
  card.classList.add('leaving');
  setTimeout(() => {
    card.remove();
    const total = document.querySelector('[data-total]');
    if (total) {
      const n = Math.max(0, Number(total.textContent) - 1);
      total.textContent = n;
      const noun = document.querySelector('[data-total-noun]');
      if (noun) noun.textContent = n === 1 ? 'story' : 'stories';
      const markAll = document.querySelector('form.mark-all');
      if (markAll && n < 2) markAll.remove();
      else if (markAll) {
        markAll.querySelector('button').textContent = `Mark all ${n} as seen`;
        markAll.dataset.confirm = `Mark all ${n} stories matching these filters as seen?`;
      }
    }
    if (!list.querySelector('article.card')) {
      list.innerHTML = filter === 'unseen'
        ? '<p class="empty">You\'re all caught up. <a href="/?view=all">Browse all stories</a></p>'
        : filter === 'saved'
          ? '<p class="empty">No stories saved yet. Tap the star on a story to keep it here.</p>'
          : '<p class="empty">No stories marked as seen.</p>';
    }
  }, 200);
  next?.querySelector('.seen-btn')?.focus();
}

// A story that is let go while the list shows only saved stories leaves the list.
function syncSaved(form, state) {
  const tabCount = document.querySelector('[data-qv-count="saved"]');
  if (tabCount) {
    const n = Math.max(0, Number(tabCount.textContent) + (state.savedAt ? 1 : -1));
    tabCount.textContent = String(n);
  }
  const card = form.closest('article.card');
  const filter = document.querySelector('.list[data-saved-filter]')?.dataset.savedFilter;
  if (card && filter === 'saved' && !state.savedAt) removeCard(card, 'saved');
}

function render(form, state) {
  for (const b of form.querySelectorAll('button.fb')) {
    const t = b.dataset.type;
    const on =
      (t === 'relevant' && state.relevanceLabel === 'relevant') ||
      (t === 'not_relevant' && state.relevanceLabel === 'not_relevant') ||
      (t === 'save' && !!state.savedAt);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    b.value = on ? b.dataset.clear : t;
    if (t === 'save') {
      b.querySelector('.fb-icon').textContent = on ? '★' : '☆';
      b.querySelector('.fb-label').textContent = on ? 'Saved' : 'Save';
      b.setAttribute('aria-label', on ? 'Saved' : 'Save');
      const help = b.dataset[on ? 'helpSaved' : 'helpUnsaved'];
      if (help) {
        b.dataset.help = help;
        // A compact button shows its meaning on a long press, so it keeps no title.
        if (b.hasAttribute('title')) b.title = help;
      }
    }
  }
}

// Icon controls: a short tap applies feedback; holding only explains the action.
const compactButton = (target) => target instanceof Element ? target.closest('.feedback-compact .fb') : null;
let feedbackHold = null;
let heldButton = null;
let helpButton = null;
let helpTooltip = null;
let helpDismissTimer = null;

// Keep native title hints as a fallback when JavaScript is unavailable.
document.querySelectorAll('.feedback-compact .fb').forEach((b) => b.removeAttribute('title'));

function hideFeedbackHelp() {
  clearTimeout(helpDismissTimer);
  helpButton?.removeAttribute('aria-describedby');
  helpButton = null;
  if (helpTooltip) helpTooltip.hidden = true;
}

function showFeedbackHelp(button, message = button.dataset.help) {
  hideFeedbackHelp();
  if (!helpTooltip) {
    helpTooltip = document.createElement('div');
    helpTooltip.id = 'feedback-help';
    helpTooltip.className = 'feedback-help';
    helpTooltip.setAttribute('role', 'tooltip');
    document.body.appendChild(helpTooltip);
  }
  helpButton = button;
  helpTooltip.textContent = message;
  helpTooltip.hidden = false;
  button.setAttribute('aria-describedby', helpTooltip.id);
  const rect = button.getBoundingClientRect();
  const tip = helpTooltip.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.left + (rect.width - tip.width) / 2, innerWidth - tip.width - 8));
  const top = rect.top - tip.height - 8;
  helpTooltip.style.left = `${left}px`;
  helpTooltip.style.top = `${Math.max(8, Math.min(top >= 8 ? top : rect.bottom + 8, innerHeight - tip.height - 8))}px`;
}

function cancelFeedbackHold() {
  if (feedbackHold) clearTimeout(feedbackHold.timer);
  feedbackHold = null;
}

function explainHeldButton(hold) {
  hold.shown = true;
  heldButton = hold.button;
  showFeedbackHelp(hold.button);
}

document.addEventListener('pointerdown', (ev) => {
  heldButton = null;
  cancelFeedbackHold();
  hideFeedbackHelp();
  const button = compactButton(ev.target);
  if (!button || button.disabled || ev.button !== 0) return;
  const hold = { button, id: ev.pointerId, x: ev.clientX, y: ev.clientY, shown: false, timer: null };
  hold.timer = setTimeout(() => { if (feedbackHold === hold) explainHeldButton(hold); }, 500);
  feedbackHold = hold;
});

document.addEventListener('pointermove', (ev) => {
  const hold = feedbackHold;
  if (!hold || ev.pointerId !== hold.id) return;
  if (Math.hypot(ev.clientX - hold.x, ev.clientY - hold.y) > 10) {
    heldButton = hold.button;
    cancelFeedbackHold();
    hideFeedbackHelp();
  }
});

document.addEventListener('pointerup', (ev) => {
  if (!feedbackHold || ev.pointerId !== feedbackHold.id) return;
  if (feedbackHold.shown) helpDismissTimer = setTimeout(hideFeedbackHelp, 2200);
  cancelFeedbackHold();
});
document.addEventListener('pointercancel', () => { cancelFeedbackHold(); hideFeedbackHelp(); });

document.addEventListener('click', (ev) => {
  const button = compactButton(ev.target);
  if (button && button === heldButton && (ev.detail > 0 || ev.pointerType)) {
    ev.preventDefault();
    ev.stopImmediatePropagation();
    heldButton = null;
    return;
  }
  hideFeedbackHelp();
}, true);

document.addEventListener('contextmenu', (ev) => {
  const button = compactButton(ev.target);
  if (!button) return;
  ev.preventDefault();
  heldButton = button;
  if (feedbackHold?.button === button) explainHeldButton(feedbackHold);
  else showFeedbackHelp(button);
});
document.addEventListener('pointerover', (ev) => {
  const button = compactButton(ev.target);
  if (button && ev.pointerType === 'mouse' && !ev.buttons) showFeedbackHelp(button);
});
document.addEventListener('pointerout', (ev) => {
  if (ev.pointerType === 'mouse' && helpButton && !helpButton.contains(ev.relatedTarget)) hideFeedbackHelp();
});
document.addEventListener('focusin', (ev) => {
  const button = compactButton(ev.target);
  if (button?.matches(':focus-visible')) showFeedbackHelp(button);
});
document.addEventListener('focusout', (ev) => { if (compactButton(ev.target)) hideFeedbackHelp(); });
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { cancelFeedbackHold(); hideFeedbackHelp(); } });
window.addEventListener('scroll', () => { cancelFeedbackHold(); hideFeedbackHelp(); }, { capture: true, passive: true });
window.addEventListener('resize', () => { cancelFeedbackHold(); hideFeedbackHelp(); });

document.addEventListener('click', (ev) => {
  const add = ev.target.closest('[data-add-topic]');
  if (!add) return;
  const container = document.getElementById('topics');
  const tpl = document.getElementById('topic-template');
  const next = Math.max(-1, ...[...container.querySelectorAll('.topic-row')].map((r) => Number(r.dataset.index))) + 1;
  const html = tpl.innerHTML.replaceAll('t.9999.', `t.${next}.`).replace('data-index="9999"', `data-index="${next}"`);
  container.insertAdjacentHTML('beforeend', html);
  container.lastElementChild.querySelector('input[name$=".label"]').focus();
});

// The map card: the button opens and closes it, and the map itself is drawn only when it
// is opened, so a story nobody looks at costs no tiles.
const leaflet = { promise: null, maps: new WeakMap() };

// The controls that need JavaScript are hidden until it is there.
document.documentElement.classList.add('js');

// ---- The timeline ------------------------------------------------------------------
// The timeline reads from the newest entry backwards, and the reader can flip it to read
// it from the start. The choice is remembered for the next story.
const TIMELINE_ORDER_KEY = 'mimir.timeline-order';

function storedTimelineOrder() {
  try {
    return localStorage.getItem(TIMELINE_ORDER_KEY) === 'oldest' ? 'oldest' : 'newest';
  } catch {
    return 'newest';
  }
}

function rememberTimelineOrder(order) {
  try {
    localStorage.setItem(TIMELINE_ORDER_KEY, order);
  } catch {
    // A browser that does not remember is a browser that does not mind.
  }
}

function applyTimelineOrder(list, order) {
  const entries = Array.from(list.querySelectorAll(':scope > li'));
  entries.sort((a, b) => Number(a.dataset.order) - Number(b.dataset.order));
  if (order === 'newest') entries.reverse();
  for (const entry of entries) list.appendChild(entry);
  list.dataset.order = order;
}

function timelineButtonFor(list) {
  return list.parentElement?.querySelector('[data-timeline-order]') ?? null;
}

function setTimelineOrder(list, order) {
  applyTimelineOrder(list, order);
  const button = timelineButtonFor(list);
  if (button) button.textContent = order === 'oldest' ? 'Newest first' : 'Oldest first';
}

for (const list of document.querySelectorAll('.timeline')) {
  // The order the reader chose, or the one the server rendered with.
  setTimelineOrder(list, storedTimelineOrder());
}

document.addEventListener('click', (ev) => {
  const button = ev.target.closest('[data-timeline-order]');
  if (!button) return;
  ev.preventDefault();
  const list = button.closest('.panel')?.querySelector('.timeline');
  if (!list) return;
  const order = list.dataset.order === 'oldest' ? 'newest' : 'oldest';
  setTimelineOrder(list, order);
  rememberTimelineOrder(order);
});

// A control in the head of a panel acts on the panel and does not fold it: the arrow
// that rewrites the brief stands on the headline, and the reader pressed the arrow,
// not the headline.
document.addEventListener('click', (ev) => {
  const control = ev.target.closest('summary button, summary a, summary input');
  if (!control) return;
  ev.stopPropagation();
});


function loadLeaflet() {
  if (window.leaflet) return Promise.resolve(window.leaflet);
  if (!leaflet.promise) {
    leaflet.promise = new Promise((resolve, reject) => {
      if (!document.querySelector('link[data-leaflet-css]')) {
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = '/static/vendor/leaflet/leaflet.css?v=1';
        css.dataset.leafletCss = '1';
        document.head.appendChild(css);
      }
      const script = document.createElement('script');
      script.src = '/static/vendor/leaflet/leaflet.js?v=1';
      script.onload = () => (window.leaflet ? resolve(window.leaflet) : reject(new Error('The map library did not load')));
      script.onerror = () => reject(new Error('The map library could not be loaded'));
      document.head.appendChild(script);
    }).catch((err) => {
      leaflet.promise = null;
      throw err;
    });
  }
  return leaflet.promise;
}

// The popup is built from nodes, not from markup: the names come from a model that read
// a third-party website.
function popupFor(place) {
  const wrap = document.createElement('div');
  wrap.className = 'map-popup';
  const name = document.createElement('strong');
  name.textContent = place.name;
  wrap.appendChild(name);
  if (place.label && place.label !== place.name) {
    const alt = document.createElement('div');
    alt.className = 'muted small';
    alt.textContent = place.label;
    wrap.appendChild(alt);
  }
  if (place.role) {
    const role = document.createElement('div');
    role.className = 'muted small';
    role.textContent = place.role;
    wrap.appendChild(role);
  }
  const where = document.createElement('div');
  where.className = 'muted small';
  where.textContent = `${place.lat.toFixed(4)}, ${place.lon.toFixed(4)}`;
  wrap.appendChild(where);
  if (place.sources && place.sources.length) {
    const list = document.createElement('ul');
    list.className = 'map-sources';
    for (const src of place.sources) {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = `/articles/${src.id}`;
      link.textContent = src.number ? `[${src.number}] ${src.title}` : src.title;
      item.appendChild(link);
      list.appendChild(item);
    }
    wrap.appendChild(list);
  }
  return wrap;
}

// The map container clips what does not fit inside it, and a popup that is clipped by
// the top edge cannot be closed. The popup is therefore never taller than the map.
function popupMaxHeight(canvas) {
  return Math.max(120, canvas.clientHeight - 70);
}

// Give the open popups the height that fits the map as it is now.
function fitPopups(card, drawn) {
  const canvas = card.querySelector('[data-map-canvas]');
  if (!canvas) return;
  const max = popupMaxHeight(canvas);
  for (const marker of drawn.markers) {
    const popup = marker.getPopup();
    if (!popup) continue;
    popup.options.maxHeight = max;
    if (popup.isOpen()) popup.update();
  }
}

function drawMap(card) {
  const canvas = card.querySelector('[data-map-canvas]');
  const source = card.querySelector('[data-map-data]');
  if (!canvas || !source) return;
  const data = JSON.parse(source.textContent);
  loadLeaflet()
    .then((L) => {
      const drawn = leaflet.maps.get(card);
      if (drawn) {
        drawn.map.invalidateSize();
        fitPopups(card, drawn);
        return;
      }
      const map = L.map(canvas, { scrollWheelZoom: false, zoomControl: false });
      // The zoom buttons sit in the bottom corner: a popup opens above its pin, and the
      // top corner is where the popup lands.
      L.control.zoom({ position: 'bottomright' }).addTo(map);
      L.tileLayer(data.tileUrl, { maxZoom: 19, attribution: data.attribution }).addTo(map);
      const bounds = [];
      const close = [];
      const markers = [];
      for (const place of data.places) {
        const icon = L.divIcon({
          className: 'map-pin-wrap',
          html: `<span class="map-pin map-pin-${place.kind}"></span>`,
          iconSize: [16, 16],
          iconAnchor: [8, 8],
          // The popup opens below the pin: a pin near the top of the map would send it
          // off the top of the card.
          popupAnchor: [0, 12],
        });
        const marker = L.marker([place.lat, place.lon], { icon, title: place.name }).addTo(map);
        marker.bindPopup(popupFor(place), { maxHeight: popupMaxHeight(canvas) });
        markers.push(marker);
        bounds.push([place.lat, place.lon]);
        if (place.kind !== 'country') close.push([place.lat, place.lon]);
      }
      // A country is a big thing whose pin sits wherever the gazetteer put it, so the
      // view is framed on the places of the story and the countries are context.
      const frame = close.length ? close : bounds;
      if (frame.length === 1) map.setView(frame[0], 9);
      else if (frame.length > 1) map.fitBounds(frame, { padding: [28, 28], maxZoom: 12 });
      else map.setView([20, 0], 1);
      leaflet.maps.set(card, { map, markers });
    })
    .catch(() => {
      const note = document.createElement('p');
      note.className = 'error-text';
      note.textContent = 'The map could not be loaded.';
      canvas.replaceChildren(note);
    });
}

// The map can take the whole screen: the places are easier to see that way, and the
// popup has room for the links of a place with many sources.
function setFullscreen(card, on) {
  const button = card.querySelector('[data-map-fullscreen]');
  card.classList.toggle('fullscreen', on);
  document.body.classList.toggle('map-open', on);
  if (button) {
    button.textContent = on ? 'Close map' : 'Full screen';
    button.setAttribute('aria-pressed', String(on));
  }
  const drawn = leaflet.maps.get(card);
  if (!drawn) return;
  // The map has a new size: the tiles and the popups have to follow it.
  requestAnimationFrame(() => {
    drawn.map.invalidateSize();
    fitPopups(card, drawn);
  });
}

// The map holds on to the card it was drawn in: it has to let go before the card is
// replaced.
function destroyMap(card) {
  if (!card) return;
  const drawn = leaflet.maps.get(card);
  if (!drawn) return;
  leaflet.maps.delete(card);
  drawn.map.remove();
}

document.addEventListener('click', (ev) => {
  const button = ev.target.closest('[data-map-fullscreen]');
  if (!button) return;
  ev.preventDefault();
  const card = button.closest('.map-panel');
  if (!card) return;
  setFullscreen(card, !card.classList.contains('fullscreen'));
});

document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  const card = document.querySelector('.map-panel.fullscreen');
  if (!card) return;
  setFullscreen(card, false);
  card.querySelector('[data-map-fullscreen]')?.focus();
});

// The map gets a new size when the window does.
window.addEventListener('resize', () => {
  for (const card of document.querySelectorAll('.map-panel')) {
    const drawn = leaflet.maps.get(card);
    if (!drawn) continue;
    drawn.map.invalidateSize();
    fitPopups(card, drawn);
  }
});

/** Open or close the map card, and remember it in the address so a reload keeps it. */
function setMapOpen(open) {
  const card = document.getElementById('story-map');
  if (!card) return;
  if (open) card.removeAttribute('hidden');
  else card.setAttribute('hidden', '');
  const toggle = document.querySelector('[data-map-toggle]');
  if (toggle) toggle.setAttribute('aria-expanded', String(open));
  const url = new URL(location.href);
  if (open) url.searchParams.set('map', '1');
  else url.searchParams.delete('map');
  history.replaceState(null, '', url);
  if (open) drawMap(card);
}

document.addEventListener('click', (ev) => {
  const toggle = ev.target.closest('[data-map-toggle]');
  if (!toggle) return;
  ev.preventDefault();
  const card = document.getElementById(toggle.getAttribute('aria-controls'));
  if (!card) return;
  setMapOpen(card.hasAttribute('hidden'));
});

// The card is open on arrival when the page was asked for with ?map=1.
for (const card of document.querySelectorAll('.map-panel:not([hidden])')) drawMap(card);

// ---- Live updates -----------------------------------------------------------------
// A story page watches its own story. When the brief or the places are written, the
// server says that the story changed, and the page puts the new story in place of the
// old one. The reader does not have to reload anything.

const live = { stream: null, poll: null, failures: 0 };

function storyCard() {
  return document.querySelector('.story-detail[data-story-id]');
}

/** Ask for the story again, and swap the fresh page in place of the one on screen. */
async function refreshStory(storyId) {
  const current = storyCard();
  if (!current || current.dataset.storyId !== String(storyId)) return;
  const res = await fetch(`${location.pathname}${location.search}`, { headers: { Accept: 'text/html' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const page = new DOMParser().parseFromString(await res.text(), 'text/html');
  const fresh = page.querySelector('.story-detail[data-story-id]');
  if (!fresh) return;
  // The story may have been merged into another one while the page was open: that is a
  // page of its own, and the browser is better at following it than the page is.
  if (fresh.dataset.storyId !== String(storyId)) {
    location.reload();
    return;
  }
  if (page.title) document.title = page.title;
  // The map belongs to the card it was drawn in: let go of it before the card goes.
  const oldMap = current.querySelector('#story-map');
  const mapOpen = oldMap ? !oldMap.hasAttribute('hidden') : false;
  const mapFull = oldMap ? oldMap.classList.contains('fullscreen') : false;
  destroyMap(oldMap);
  // The panels that fold away are folded by default, but a reader who opened one keeps
  // it open.
  const openPanels = new Set(
    [...current.querySelectorAll('details[id][open]')].map((panel) => panel.id),
  );
  // The counters in the fresh story are counted from the moment the page arrived.
  for (const counter of fresh.querySelectorAll('[data-elapsed-since]')) {
    counter.setAttribute('data-elapsed-arrived', String(Date.now()));
  }
  current.replaceWith(fresh);
  ensureElapsedTicker();
  const list = fresh.querySelector('.timeline');
  if (list) setTimelineOrder(list, storedTimelineOrder());
  const map = fresh.querySelector('#story-map');
  if (map && mapFull) setFullscreen(map, true);
  if (map && mapOpen) drawMap(map);
  for (const panel of fresh.querySelectorAll('details[id]')) {
    if (openPanels.has(panel.id)) panel.setAttribute('open', '');
  }
}

function stopWatching() {
  if (live.stream) {
    live.stream.close();
    live.stream = null;
  }
  if (live.poll) {
    clearInterval(live.poll);
    live.poll = null;
  }
}

/** Watch a story over an event stream: the server writes when the story changes. */
function startWatching(storyId) {
  stopWatching();
  live.failures = 0;
  const source = new EventSource(`/api/stories/${storyId}/events`);
  live.stream = source;
  source.addEventListener('change', (ev) => {
    let version = '';
    try {
      version = JSON.parse(ev.data).version;
    } catch {
      return;
    }
    if (!version || version === storyCard()?.dataset.version) return;
    refreshStory(storyId).catch(() => {});
  });
  source.onerror = () => {
    // The browser reconnects on its own; when it gives up, the page asks instead.
    if (source.readyState !== EventSource.CLOSED) return;
    live.failures += 1;
    if (live.failures >= 3) startPolling(storyId);
  };
}

/** The same watch for a browser that cannot hold an event stream open. */
function startPolling(storyId) {
  stopWatching();
  live.poll = setInterval(async () => {
    try {
      const res = await fetch(`/api/stories/${storyId}/state`, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { version } = await res.json();
      if (!version || version === storyCard()?.dataset.version) return;
      await refreshStory(storyId);
    } catch {
      // The next tick tries again.
    }
  }, 3000);
}

const watched = storyCard();
if (watched) startWatching(watched.dataset.storyId);

/** A short notice at the top of the page, for the result of a button. */
function showNotice(message, isError = false) {
  document.querySelector('[data-live-notice]')?.remove();
  if (!message) return;
  const banner = document.createElement('div');
  banner.className = isError ? 'banner error' : 'banner ok';
  banner.setAttribute('role', 'status');
  banner.dataset.liveNotice = '';
  banner.textContent = message;
  document.querySelector('main')?.prepend(banner);
  setTimeout(() => banner.remove(), 8000);
}

// The two buttons of a story page ask the server to write something. The page watches
// for the result, so the button does not have to reload the page.
document.addEventListener('submit', async (ev) => {
  const form = ev.target;
  const action = form.dataset.storyAction;
  if (!action) return;
  ev.preventDefault();
  const button = ev.submitter;
  const url = new URL(form.action, location.href);
  url.pathname = url.pathname.replace('/stories/', '/api/stories/');
  if (button) button.disabled = true;
  try {
    const res = await fetch(url, { method: 'POST', headers: { Accept: 'application/json' } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    if (action === 'places') setMapOpen(true);
    showNotice(body.message ?? 'Queued.');
    // Nothing was queued, so no new page will come: the button has to be usable again.
    if (body.queued === false && button) button.disabled = false;
  } catch (err) {
    showNotice(err.message, true);
    if (button) button.disabled = false;
  }
});

// ---- Terms -------------------------------------------------------------------------
// A term in a brief or in an article can be tapped. The page asks the server what the
// term is, and shows the answer in a small card. The card is built from DOM nodes, so
// nothing that came out of the encyclopedia is ever treated as markup.

const termCache = new Map();
let termCard = null;
let termAnchor = null;

async function termExplanation(key) {
  if (termCache.has(key)) return termCache.get(key);
  const res = await fetch(`/api/terms/${encodeURIComponent(key)}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('This term is not in the glossary yet.');
  const body = await res.json();
  termCache.set(key, body);
  return body;
}

function closeTermCard() {
  if (termCard) termCard.remove();
  termCard = null;
  if (termAnchor) termAnchor.setAttribute('aria-expanded', 'false');
  termAnchor = null;
}

/** Put the card under the term, and keep it inside the window. */
function placeTermCard(button, card) {
  const rect = button.getBoundingClientRect();
  const width = Math.min(320, window.innerWidth - 16);
  card.style.width = `${width}px`;
  const height = card.offsetHeight;
  let left = rect.left;
  let top = rect.bottom + 6;
  if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
  if (left < 8) left = 8;
  if (top + height > window.innerHeight - 8) {
    const above = rect.top - height - 6;
    top = above >= 8 ? above : Math.max(8, window.innerHeight - height - 8);
  }
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
}

function showTermCard(button, term) {
  closeTermCard();
  const card = document.createElement('div');
  card.className = 'term-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', term.name);

  const name = document.createElement('strong');
  name.className = 'term-card-name';
  name.textContent = term.name;
  card.appendChild(name);

  if (term.description) {
    const desc = document.createElement('span');
    desc.className = 'term-card-desc';
    desc.textContent = term.description;
    card.appendChild(desc);
  }
  if (term.summary && term.summary !== term.description) {
    const text = document.createElement('span');
    text.className = 'term-card-text';
    text.textContent = term.summary;
    card.appendChild(text);
  }
  if (term.sourceUrl && term.sourceUrl.startsWith('https://')) {
    const link = document.createElement('a');
    link.className = 'term-card-source';
    link.href = term.sourceUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = term.sourceName || 'Source';
    card.appendChild(link);
  }
  document.body.appendChild(card);
  termCard = card;
  termAnchor = button;
  button.setAttribute('aria-expanded', 'true');
  placeTermCard(button, card);
}

document.addEventListener('click', (ev) => {
  const target = ev.target instanceof Element ? ev.target : null;
  const term = target?.closest('.term[data-term-key]');
  if (term) {
    ev.preventDefault();
    if (termAnchor === term) {
      closeTermCard();
      return;
    }
    const key = term.getAttribute('data-term-key') || '';
    termExplanation(key)
      .then((t) => showTermCard(term, t))
      .catch((err) => showNotice(err.message, true));
    return;
  }
  if (termCard && !target?.closest('.term-card')) closeTermCard();
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && termCard) closeTermCard();
});

window.addEventListener('scroll', () => closeTermCard(), { capture: true, passive: true });
window.addEventListener('resize', () => closeTermCard());

// ---- The writing counter ------------------------------------------------------------
// While a brief is being written, the page counts the seconds next to the badge. The
// start time comes from the server, so the count is right even after the page has put
// a fresh story in place of the old one; the browser only does the counting.

let elapsedTimer = null;
// How far the clock of the browser is behind the clock of the server, per counter.
const elapsedSkew = new WeakMap();

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
  if (minutes) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

/**
 * The gap between the two clocks, worked out once per counter: the server says what
 * time it was when it wrote the page, and the browser says what time it was when the
 * page arrived. The gap is the same a second later, so the count keeps up.
 */
function skewFor(el) {
  let skew = elapsedSkew.get(el);
  if (skew === undefined) {
    const serverNow = Date.parse(el.getAttribute('data-elapsed-now') || '');
    const arrived = Number(el.getAttribute('data-elapsed-arrived')) || Date.now();
    skew = Number.isNaN(serverNow) ? 0 : serverNow - arrived;
    elapsedSkew.set(el, skew);
  }
  return skew;
}

function tickElapsed() {
  const counters = document.querySelectorAll('[data-elapsed-since]');
  if (!counters.length) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
    return;
  }
  const now = Date.now();
  for (const el of counters) {
    const since = Date.parse(el.getAttribute('data-elapsed-since') || '');
    if (Number.isNaN(since)) continue;
    const label = formatElapsed(now + skewFor(el) - since);
    el.textContent = label;
    const what = el.getAttribute('data-elapsed-what');
    if (what) el.setAttribute('title', `${what} for ${label}`);
  }
}

/** Start counting, when there is something to count. */
function ensureElapsedTicker() {
  if (elapsedTimer || !document.querySelector('[data-elapsed-since]')) return;
  tickElapsed();
  elapsedTimer = setInterval(tickElapsed, 1000);
}

ensureElapsedTicker();
