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
        : '<p class="empty">No stories marked as seen.</p>';
    }
  }, 200);
  next?.querySelector('.seen-btn')?.focus();
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

document.addEventListener('click', (ev) => {
  const toggle = ev.target.closest('[data-map-toggle]');
  if (!toggle) return;
  ev.preventDefault();
  const card = document.getElementById(toggle.getAttribute('aria-controls'));
  if (!card) return;
  const open = card.hasAttribute('hidden');
  if (open) card.removeAttribute('hidden');
  else card.setAttribute('hidden', '');
  toggle.setAttribute('aria-expanded', String(open));
  const url = new URL(location.href);
  if (open) url.searchParams.set('map', '1');
  else url.searchParams.delete('map');
  history.replaceState(null, '', url);
  if (open) drawMap(card);
});

// The card is open on arrival when the page was asked for with ?map=1.
for (const card of document.querySelectorAll('.map-panel:not([hidden])')) drawMap(card);

// While the places of a story are being looked up, wait for the answer.
for (const card of document.querySelectorAll('[data-places-story]')) {
  const storyId = card.dataset.placesStory;
  const wait = async () => {
    try {
      const res = await fetch(`/api/stories/${storyId}/places`, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.state === 'pending' || data.state === 'running') {
        setTimeout(wait, 3000);
        return;
      }
      location.reload();
    } catch {
      setTimeout(wait, 5000);
    }
  };
  setTimeout(wait, 3000);
}
