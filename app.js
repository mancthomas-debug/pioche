'use strict';
/* Pioche — liste perso de choses à voir, lire, écouter, visiter.
   Vanilla JS, aucune dépendance, stockage IndexedDB. */

// ---------- Catégories ----------
const CATS = {
  film:      { label: 'Film',      emoji: '🎬', api: 'tmdb' },
  serie:     { label: 'Série',     emoji: '📺', api: 'tmdb' },
  livre:     { label: 'Livre',     emoji: '📚', api: 'books' },
  spectacle: { label: 'Spectacle', emoji: '🎭', api: null },
  musique:   { label: 'Musique',   emoji: '🎵', api: 'itunes' },
  podcast:   { label: 'Podcast',   emoji: '🎙️', api: 'itunes' },
  expo:      { label: 'Expo',      emoji: '🖼️', api: null },
  lieu:      { label: 'Lieu',      emoji: '📍', api: null },
  autre:     { label: 'Autre',     emoji: '✨', api: null },
};
const STATUTS = { a_decouvrir: 'À découvrir', en_cours: 'En cours', fait: 'Fait' };

// ---------- Utilitaires ----------
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const enc = encodeURIComponent;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2200);
}
const safeUrl = u => (/^(https?:|data:image\/)/i.test(u || '') ? u : '');

// ---------- IndexedDB ----------
const db = {
  _p: null,
  open() {
    return this._p ||= new Promise((res, rej) => {
      const r = indexedDB.open('pioche', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('items', { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async tx(mode, fn) {
    const d = await this.open();
    return new Promise((res, rej) => {
      const t = d.transaction('items', mode); const s = t.objectStore('items');
      const out = fn(s);
      t.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
      t.onerror = () => rej(t.error);
    });
  },
  all() { return this.tx('readonly', s => s.getAll()); },
  put(item) { return this.tx('readwrite', s => s.put(item)); },
  del(id) { return this.tx('readwrite', s => s.delete(id)); },
  putMany(items) { return this.tx('readwrite', s => { items.forEach(i => s.put(i)); }); },
};

// ---------- État ----------
const state = { items: [], cat: 'all', statut: 'a_decouvrir', q: '', addCat: 'film', current: null };
const settings = {
  get tmdb() { return localStorage.getItem('pioche.tmdb') || ''; },
  set tmdb(v) { localStorage.setItem('pioche.tmdb', v.trim()); },
  get gbooks() { return localStorage.getItem('pioche.gbooks') || ''; },
  set gbooks(v) { localStorage.setItem('pioche.gbooks', v.trim()); },
};

// ---------- APIs ----------
async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
// JSONP en repli (iTunes le supporte) si CORS bloque.
function jsonp(url) {
  return new Promise((res, rej) => {
    const cb = '__pioche_cb' + Math.random().toString(36).slice(2);
    const s = document.createElement('script');
    const clean = () => { delete window[cb]; s.remove(); };
    window[cb] = d => { clean(); res(d); };
    s.onerror = () => { clean(); rej(new Error('JSONP')); };
    s.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + cb;
    document.head.appendChild(s);
    setTimeout(() => { if (window[cb]) { clean(); rej(new Error('timeout')); } }, 10000);
  });
}

const TMDB_IMG = 'https://image.tmdb.org/t/p/';
function tmdb(path, params = {}) {
  const key = settings.tmdb;
  if (!key) throw new Error('NOKEY');
  const q = new URLSearchParams({ language: 'fr-FR', ...params });
  const opts = {};
  if (key.length > 40) opts.headers = { Authorization: 'Bearer ' + key }; // jeton v4
  else q.set('api_key', key);                                             // clé v3
  return getJSON(`https://api.themoviedb.org/3${path}?${q}`, opts);
}

// Liens de recherche directe vers les plateformes (ouvrent l'appli sur iPhone si installée).
const PLATFORM_SEARCH = [
  [/netflix/i, t => `https://www.netflix.com/search?q=${enc(t)}`],
  [/amazon|prime/i, t => `https://www.primevideo.com/search/ref=atv_nb_sug?phrase=${enc(t)}`],
  [/disney/i, t => `https://www.disneyplus.com/fr-fr/search?q=${enc(t)}`],
  [/canal/i, t => `https://www.canalplus.com/recherche/?q=${enc(t)}`],
  [/apple tv/i, t => `https://tv.apple.com/fr/search?term=${enc(t)}`],
  [/^max$|hbo/i, t => `https://play.max.com/search?q=${enc(t)}`],
  [/paramount/i, t => `https://www.paramountplus.com/fr/search/?q=${enc(t)}`],
  [/arte/i, t => `https://www.arte.tv/fr/search/?q=${enc(t)}`],
  [/france\.tv|france tv/i, t => `https://www.france.tv/recherche/?q=${enc(t)}`],
];

const search = {
  async tmdb(cat, q) {
    const type = cat === 'film' ? 'movie' : 'tv';
    const d = await tmdb(`/search/${type}`, { query: q, include_adult: 'false' });
    return d.results.slice(0, 12).map(r => ({
      _ref: { type, id: r.id },
      titre: r.title || r.name,
      annee: +(r.release_date || r.first_air_date || '').slice(0, 4) || null,
      image: r.poster_path ? TMDB_IMG + 'w342' + r.poster_path : '',
      sub: r.original_title && r.original_title !== r.title ? r.original_title : (r.original_name !== r.name ? r.original_name : ''),
    }));
  },
  // Livres : BnF (catalogue français, toujours dispo) + Google Books si une clé est saisie,
  // repli Open Library si les deux échouent.
  async books(cat, q) {
    const [bnf, gb] = await Promise.all([
      search.bnf(q).catch(e => (console.warn('BnF', e), [])),
      settings.gbooks ? search.gbooks(q).catch(e => (console.warn('Google Books', e), [])) : [],
    ]);
    // Classement local : mots de la requête présents, titre court, auteur et ISBN connus, édition récente.
    const words = norm(q).split(/[^a-z0-9]+/).filter(w => w.length > 1);
    const score = r => {
      const t = norm(r.titre), a = norm(r.sub);
      const inT = words.filter(w => t.includes(w)).length, inA = words.filter(w => a.includes(w)).length;
      return (inT + inA) / (words.length || 1) * 10 + (inT && !t.startsWith(words[0]) ? -1 : 0)
        - t.length / 25 + (r.sub ? 2 : -4) + (r.isbn ? 2 : 0) + (r.image && r._ref.src === 'gb' ? 1 : 0)
        + Math.min((r.annee || 1950) - 1950, 75) / 50 - (/^["«]/.test(r.titre) ? 4 : 0);
    };
    const ranked = [...gb, ...bnf].map(r => ({ r, s: score(r) })).sort((x, y) => y.s - x.s).map(x => x.r);
    const seen = new Set(); const out = [];
    for (const r of ranked) {
      const k = norm(r.titre).replace(/\W+/g, '').slice(0, 30) + '|' + norm(r.sub).split(/[ ,]/).pop();
      if (seen.has(k)) continue; seen.add(k); out.push(r);
    }
    if (out.length) return out.slice(0, 15);
    return search.openlibrary(q);
  },
  async bnf(q) {
    const cql = `bib.anywhere all "${q.replace(/"/g, ' ')}" and bib.doctype any "a"`;
    const url = `https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve&recordSchema=dublincore&maximumRecords=25&query=${enc(cql)}`;
    const r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status);
    const xml = new DOMParser().parseFromString(await r.text(), 'application/xml');
    const DC = 'http://purl.org/dc/elements/1.1/';
    return [...xml.getElementsByTagNameNS('http://www.openarchives.org/OAI/2.0/oai_dc/', 'dc')].map(rec => {
      const all = n => [...rec.getElementsByTagNameNS(DC, n)].map(e => e.textContent.trim());
      const ark = (all('identifier').find(s => s.includes('ark:')) || '').replace(/^.*?(ark:\S+)$/, '$1');
      const isbn = (all('identifier').find(s => /^ISBN/.test(s)) || '').replace(/[^\dX]/gi, '') || undefined;
      const creators = all('creator');
      const main = creators.find(c => /Auteur du texte/i.test(c)) || creators[0] || '';
      const auteur = main.replace(/\s*\(.*$|\.\s*Auteur.*$/g, '').split(',').map(s => s.trim()).reverse().join(' ').trim();
      const titre = (all('title')[0] || '').split(' / ')[0].replace(/\s*\[.*?\]\s*/g, ' ').replace(/\s*\(.*$/, '')
        .replace(/\s*:\s*(roman|récit|nouvelles|essai|théâtre|poèmes)\s*$/i, '').replace(/\s*\((Nouvelle éd|Éd\.)[^)]*\)?.*$/i, '').trim();
      return {
        _ref: { src: 'bnf', ark, editeur: all('publisher')[0] || '' },
        titre, annee: +(all('date')[0] || '').slice(0, 4) || null, sub: auteur, isbn,
        image: ark ? `https://catalogue.bnf.fr/couverture?&appName=NE&idArk=${ark}&couverture=1` : '',
        imageAlt: isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg?default=false` : '',
      };
    }).filter(r => r.titre);
  },
  async gbooks(q, isbn) {
    const qq = isbn ? 'isbn:' + isbn : q;
    const d = await getJSON(`https://www.googleapis.com/books/v1/volumes?q=${enc(qq)}&maxResults=12&printType=books&langRestrict=fr&country=FR&key=${enc(settings.gbooks)}`);
    return (d.items || []).map(v => {
        const i = v.volumeInfo || {};
        const isbn = (i.industryIdentifiers || []).find(x => x.type === 'ISBN_13') || (i.industryIdentifiers || [])[0];
        return {
          _ref: { src: 'gb', v },
          titre: i.title + (i.subtitle ? ' — ' + i.subtitle : ''),
          annee: +(i.publishedDate || '').slice(0, 4) || null,
          image: (i.imageLinks?.thumbnail || i.imageLinks?.smallThumbnail || '').replace('http:', 'https:').replace('&edge=curl', ''),
          sub: (i.authors || []).join(', '),
          isbn: isbn?.identifier,
        };
      });
  },
  async openlibrary(q) {
    const d = await getJSON(`https://openlibrary.org/search.json?q=${enc(q)}&limit=12&fields=key,title,author_name,first_publish_year,cover_i,isbn`);
    return d.docs.map(o => ({
      _ref: { src: 'ol', o },
      titre: o.title, annee: o.first_publish_year || null,
      image: o.cover_i ? `https://covers.openlibrary.org/b/id/${o.cover_i}-L.jpg` : '',
      sub: (o.author_name || []).join(', '), isbn: (o.isbn || [])[0],
    }));
  },
  async itunes(cat, q) {
    const p = cat === 'podcast' ? 'media=podcast&entity=podcast' : 'media=music&entity=album';
    const url = `https://itunes.apple.com/search?term=${enc(q)}&${p}&country=FR&lang=fr_fr&limit=12`;
    let d;
    try { d = await getJSON(url); } catch { d = await jsonp(url); }
    return d.results.map(r => ({
      _ref: r,
      titre: r.collectionName || r.trackName,
      annee: +(r.releaseDate || '').slice(0, 4) || null,
      image: (r.artworkUrl100 || '').replace('100x100', '600x600'),
      sub: r.artistName,
    }));
  },
};

// Transforme un résultat choisi en élément complet (appels détaillés si nécessaire).
async function hydrate(cat, r) {
  const base = { titre: r.titre, annee: r.annee, image: r.image, liens: [], plateformes: [], externalId: {} };
  if (CATS[cat].api === 'tmdb') {
    const { type, id } = r._ref;
    const d = await tmdb(`/${type}/${id}`, { append_to_response: 'watch/providers,credits' });
    const fr = d['watch/providers']?.results?.FR || {};
    const seen = new Set(); const plats = [];
    for (const p of [...(fr.flatrate || []), ...(fr.free || []), ...(fr.ads || [])]) {
      if (seen.has(p.provider_id)) continue; seen.add(p.provider_id);
      plats.push({ nom: p.provider_name, logo: TMDB_IMG + 'w92' + p.logo_path });
    }
    const titre = d.title || d.name;
    const liens = [];
    for (const p of plats) {
      const m = PLATFORM_SEARCH.find(([re]) => re.test(p.nom));
      if (m && !liens.some(l => l.libelle === p.nom)) liens.push({ libelle: p.nom, url: m[1](titre) });
    }
    if (fr.link) liens.push({ libelle: 'Où regarder (JustWatch)', url: fr.link });
    liens.push({ libelle: 'TMDB', url: `https://www.themoviedb.org/${type}/${id}?language=fr-FR` });
    const createur = type === 'movie'
      ? (d.credits?.crew || []).filter(c => c.job === 'Director').map(c => c.name).join(', ')
      : (d.created_by || []).map(c => c.name).join(', ');
    return { ...base, titre, image: d.poster_path ? TMDB_IMG + 'w500' + d.poster_path : base.image,
      resume: d.overview || '', auteurOuCreateur: createur,
      genres: (d.genres || []).map(g => g.name), plateformes: plats, liens,
      plateformesMaj: new Date().toISOString(), externalId: { tmdb: `${type}/${id}` } };
  }
  if (cat === 'livre') {
    let resume = '', auteur = r.sub, gbLink = '', gbId, image = r.image, v = r._ref.v;
    // Notice BnF : on tente de compléter (résumé, couverture) via Google Books par ISBN.
    if (r._ref.src === 'bnf' && r.isbn && settings.gbooks) {
      try { v = (await search.gbooks('', r.isbn))[0]?._ref.v; } catch {}
    }
    if (v) {
      const i = v.volumeInfo; gbId = v.id;
      resume = (i.description || '').replace(/<[^>]+>/g, ''); gbLink = i.infoLink || i.canonicalVolumeLink;
      if (!image && i.imageLinks?.thumbnail) image = i.imageLinks.thumbnail.replace('http:', 'https:');
    }
    if (r._ref.src === 'bnf' && r._ref.editeur) resume = resume || `Éditeur : ${r._ref.editeur}`;
    const q = r.isbn || `${r.titre} ${auteur || ''}`.trim();
    const liens = [
      { libelle: 'Fnac', url: `https://www.fnac.com/SearchResult/ResultList.aspx?Search=${enc(q)}` },
      { libelle: 'Leslibraires.fr', url: `https://www.leslibraires.fr/recherche/?q=${enc(q)}` },
      { libelle: 'Decitre', url: `https://www.decitre.fr/rechercher/result?q=${enc(q)}` },
    ];
    if (gbLink) liens.push({ libelle: 'Google Books', url: gbLink.replace('http:', 'https:') });
    if (r._ref.ark) liens.push({ libelle: 'Notice BnF', url: 'https://catalogue.bnf.fr/' + r._ref.ark });
    if (r._ref.src === 'ol') liens.push({ libelle: 'Open Library', url: 'https://openlibrary.org' + r._ref.o.key });
    return { ...base, image, imageAlt: r.imageAlt || '', auteurOuCreateur: auteur, resume, liens,
      externalId: { isbn: r.isbn, googleBooks: gbId } };
  }
  if (CATS[cat].api === 'itunes') {
    const x = r._ref;
    const url = x.collectionViewUrl || x.trackViewUrl;
    return { ...base, auteurOuCreateur: x.artistName, resume: x.primaryGenreName ? 'Genre : ' + x.primaryGenreName : '',
      liens: url ? [{ libelle: cat === 'podcast' ? 'Apple Podcasts' : 'Apple Music', url }] : [],
      externalId: { itunes: x.collectionId || x.trackId } };
  }
  return base;
}

// ---------- Liste ----------
function renderChips() {
  const counts = {};
  for (const i of state.items) if (i.statut === state.statut) counts[i.categorie] = (counts[i.categorie] || 0) + 1;
  const keys = ['all', ...Object.keys(CATS).filter(k => counts[k] || state.cat === k)];
  $('#cat-chips').innerHTML = keys.map(k => {
    const lbl = k === 'all' ? 'Tout' : `${CATS[k].emoji} ${CATS[k].label}`;
    return `<button class="chip ${state.cat === k ? 'on' : ''}" data-cat="${k}">${lbl}${k !== 'all' ? ` <small>${counts[k] || 0}</small>` : ''}</button>`;
  }).join('');
}
const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// Image avec repli : image → imageAlt → emoji de la catégorie.
function imgFail(el) {
  const alt = el.dataset.alt;
  if (alt) { el.dataset.alt = ''; el.src = alt; return; }
  if (el.dataset.cls) el.outerHTML = `<div class="${el.dataset.cls}">${el.dataset.emoji}</div>`; else el.remove();
}
window.imgFail = imgFail;
function img(i, cls, withEmoji = true) {
  const src = safeUrl(i.image) || safeUrl(i.imageAlt);
  const emoji = CATS[i.categorie]?.emoji || '✨';
  if (!src) return withEmoji ? `<div class="${cls}">${emoji}</div>` : '';
  const alt = src === i.image ? safeUrl(i.imageAlt) : '';
  return `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy" data-alt="${esc(alt)}" data-cls="${withEmoji ? cls : ''}" data-emoji="${emoji}" onerror="imgFail(this)">`;
}
const thumb = (i, cls = 'thumb') => img(i, cls);
function renderList() {
  renderChips();
  const q = norm(state.q);
  const list = state.items
    .filter(i => i.statut === state.statut)
    .filter(i => state.cat === 'all' || i.categorie === state.cat)
    .filter(i => !q || norm([i.titre, i.auteurOuCreateur, i.source, i.note].join(' ')).includes(q))
    .sort((a, b) => (state.statut === 'fait' ? (b.dateFait || '').localeCompare(a.dateFait || '') : 0) || b.dateAjout.localeCompare(a.dateAjout));
  $('#list').innerHTML = list.map(i => `
    <li class="card" data-id="${esc(i.id)}">
      ${thumb(i)}
      <div>
        <div class="t">${esc(i.titre)}</div>
        <div class="s">${CATS[i.categorie]?.emoji || ''} ${[i.annee, i.auteurOuCreateur].filter(Boolean).map(esc).join(' · ')}</div>
        ${i.source ? `<div class="s">↳ ${esc(i.source)}</div>` : ''}
        ${i.plateformes?.length ? `<div class="plats">${i.plateformes.slice(0, 6).map(p => `<img src="${esc(safeUrl(p.logo))}" alt="${esc(p.nom)}" title="${esc(p.nom)}">`).join('')}</div>` : ''}
      </div>
    </li>`).join('');
  $('#empty').hidden = list.length > 0;
  $('#empty').textContent = state.q ? 'Aucun résultat.' : state.statut === 'a_decouvrir'
    ? "Rien ici pour l'instant. Touchez + pour piocher une idée." : 'Rien ici pour l’instant.';
}
async function reload() { state.items = await db.all(); renderList(); }

// ---------- Ajout ----------
function renderAddCats() {
  $('#add-cats').innerHTML = Object.entries(CATS).map(([k, c]) =>
    `<button class="chip ${state.addCat === k ? 'on' : ''}" data-cat="${k}">${c.emoji} ${c.label}</button>`).join('');
  const api = CATS[state.addCat].api;
  $('#add-link').hidden = !!api;
  $('#add-title').placeholder = api ? 'Titre (recherche en ligne)…' : 'Titre…';
  $('#add-manual').textContent = api ? 'Ajouter sans recherche' : 'Ajouter';
}
function openAdd() {
  state.addCat = localStorage.getItem('pioche.lastCat') || 'film';
  ['#add-title', '#add-source', '#add-link'].forEach(s => ($(s).value = ''));
  $('#results').innerHTML = ''; $('#add-msg').textContent = '';
  renderAddCats();
  $('#dlg-add').showModal();
  $('#add-title').focus();
}
let searchSeq = 0;
const runSearch = debounce(async () => {
  const q = $('#add-title').value.trim(); const cat = state.addCat; const api = CATS[cat].api;
  const seq = ++searchSeq;
  if (!api || q.length < 2) { $('#results').innerHTML = ''; $('#add-msg').textContent = ''; return; }
  if (!navigator.onLine) { $('#add-msg').textContent = 'Hors ligne : utilisez « Ajouter sans recherche ».'; return; }
  $('#add-msg').textContent = 'Recherche…';
  try {
    const res = await search[api](cat, q);
    if (seq !== searchSeq) return;
    state.results = res;
    $('#add-msg').textContent = !res.length ? 'Aucun résultat.'
      : cat === 'livre' ? 'Astuce : ajoutez le nom de l’auteur pour affiner.' : '';
    $('#results').innerHTML = res.map((r, n) => `
      <li data-n="${n}">${thumb({ image: r.image, imageAlt: r.imageAlt, categorie: cat })}
        <div><div class="t"><strong>${esc(r.titre)}</strong></div>
        <div class="s">${[r.annee, r.sub].filter(Boolean).map(esc).join(' · ')}</div></div></li>`).join('');
  } catch (e) {
    if (seq !== searchSeq) return;
    $('#results').innerHTML = '';
    $('#add-msg').textContent = e.message === 'NOKEY'
      ? 'Ajoutez votre clé TMDB dans les Réglages (⚙︎) pour la recherche films/séries.'
      : 'Recherche impossible (' + e.message + '). Vous pouvez ajouter sans recherche.';
  }
}, 350);

function newItem(cat, data) {
  const lien = $('#add-link').value.trim();
  const liens = [...(data.liens || [])];
  if (lien && /^https?:/i.test(lien)) liens.unshift({ libelle: cat === 'spectacle' ? 'Billetterie' : 'Lien', url: lien });
  return {
    id: uuid(), categorie: cat, titre: data.titre, image: data.image || '', imageAlt: data.imageAlt || '', annee: data.annee || null,
    auteurOuCreateur: data.auteurOuCreateur || '', resume: data.resume || '', genres: data.genres || [],
    liens, plateformes: data.plateformes || [], plateformesMaj: data.plateformesMaj,
    source: $('#add-source').value.trim(), note: '', statut: 'a_decouvrir',
    dateAjout: new Date().toISOString(), dateFait: null, externalId: data.externalId || {},
  };
}
async function addItem(item) {
  await db.put(item);
  localStorage.setItem('pioche.lastCat', item.categorie);
  $('#dlg-add').close();
  state.statut = 'a_decouvrir'; state.cat = 'all'; syncSeg();
  await reload();
  toast('Ajouté : ' + item.titre);
  return item;
}

// ---------- Détail ----------
function openDetail(id) {
  const i = state.items.find(x => x.id === id); if (!i) return;
  state.current = i;
  $('#detail-cat').textContent = `${CATS[i.categorie]?.emoji || ''} ${CATS[i.categorie]?.label || ''}`;
  $('#detail-body').innerHTML = `<div class="detail">
    ${img(i, 'detail-img', false)}
    <h2>${esc(i.titre)}</h2>
    <div class="meta">${[i.annee, i.auteurOuCreateur, (i.genres || []).join(', ')].filter(Boolean).map(esc).join(' · ')}</div>
    ${i.source ? `<p class="meta">Conseillé par / source : <strong>${esc(i.source)}</strong></p>` : ''}
    ${i.plateformes?.length ? `<h3>En France sur</h3><div class="plat-row">${i.plateformes.map(p =>
      `<span class="plat"><img src="${esc(safeUrl(p.logo))}" alt="">${esc(p.nom)}</span>`).join('')}</div>`
      : (CATS[i.categorie]?.api === 'tmdb' && i.externalId?.tmdb ? '<p class="meta">Pas disponible en streaming par abonnement en France (selon TMDB).</p>' : '')}
    ${i.liens?.length ? `<div class="links">${i.liens.filter(l => /^https?:/i.test(l.url)).map(l =>
      `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.libelle || 'Lien')} ↗</a>`).join('')}</div>` : ''}
    ${i.resume ? `<p>${esc(i.resume)}</p>` : ''}
    ${i.note ? `<p><em>${esc(i.note)}</em></p>` : ''}
    <p class="hint">Ajouté le ${new Date(i.dateAjout).toLocaleDateString('fr-FR')}${i.dateFait ? ` · fait le ${new Date(i.dateFait).toLocaleDateString('fr-FR')}` : ''}</p>
    <div class="seg" id="detail-statut">${Object.entries(STATUTS).map(([k, v]) =>
      `<button data-s="${k}" class="${i.statut === k ? 'on' : ''}">${v}</button>`).join('')}</div>
    ${i.externalId?.tmdb ? '<button class="btn secondary" id="btn-refresh">Actualiser les plateformes</button>' : ''}
    <button class="btn danger" id="btn-delete">Supprimer</button>
  </div>`;
  if (!$('#dlg-detail').open) $('#dlg-detail').showModal();
  $('#dlg-detail').scrollTop = 0;
}
async function setStatut(s) {
  const i = state.current; i.statut = s;
  i.dateFait = s === 'fait' ? (i.dateFait || new Date().toISOString()) : null;
  await db.put(i); await reload(); openDetail(i.id);
  toast(STATUTS[s]);
}

// ---------- Édition ----------
const EDIT_FIELDS = [
  ['titre', 'Titre', 'text'], ['categorie', 'Catégorie', 'cat'], ['auteurOuCreateur', 'Auteur / réalisateur / artiste', 'text'],
  ['annee', 'Année', 'number'], ['source', 'Conseillé par / source', 'text'], ['image', "URL de l'image", 'url'],
  ['photo', 'Ou une photo', 'file'], ['resume', 'Résumé', 'area'], ['note', 'Note perso', 'area'], ['liens', 'Liens (un par ligne : Libellé | https://…)', 'links'],
];
function openEdit(item) {
  state.editing = { ...item };
  $('#edit-form').innerHTML = EDIT_FIELDS.map(([k, label, t]) => {
    const v = item[k] ?? '';
    let input;
    if (t === 'cat') input = `<select name="${k}">${Object.entries(CATS).map(([c, o]) => `<option value="${c}" ${c === v ? 'selected' : ''}>${o.emoji} ${o.label}</option>`).join('')}</select>`;
    else if (t === 'area') input = `<textarea name="${k}" rows="4">${esc(v)}</textarea>`;
    else if (t === 'links') input = `<textarea name="${k}" rows="4">${esc((item.liens || []).map(l => `${l.libelle} | ${l.url}`).join('\n'))}</textarea>`;
    else if (t === 'file') input = `<input name="${k}" type="file" accept="image/*">`;
    else input = `<input name="${k}" type="${t}" value="${esc(t === 'url' && String(v).startsWith('data:') ? '(photo enregistrée)' : v)}">`;
    return `<label>${label}${input}</label>`;
  }).join('');
  $('#dlg-edit').showModal();
}
async function saveEdit() {
  const f = new FormData($('#edit-form')); const it = state.editing;
  it.titre = (f.get('titre') || '').trim() || 'Sans titre';
  it.categorie = f.get('categorie');
  it.auteurOuCreateur = f.get('auteurOuCreateur').trim();
  it.annee = +f.get('annee') || null;
  it.source = f.get('source').trim();
  const img = f.get('image').trim();
  if (img !== '(photo enregistrée)') it.image = img;
  const file = f.get('photo');
  if (file && file.size) it.image = await resizeImage(file);
  it.resume = f.get('resume').trim();
  it.note = f.get('note').trim();
  it.liens = f.get('liens').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const m = l.match(/^(.*?)\s*\|\s*(https?:\/\/\S+)$/) || [null, 'Lien', l];
    return { libelle: m[1] || 'Lien', url: m[2] };
  }).filter(l => /^https?:/i.test(l.url));
  const isNew = !state.items.some(x => x.id === it.id);
  await db.put(it); await reload();
  $('#dlg-edit').close();
  if (!isNew) openDetail(it.id); else toast('Ajouté : ' + it.titre);
}
// Photo de la pellicule → JPEG redimensionné en data URL (exportable dans le JSON).
function resizeImage(file, max = 800) {
  return new Promise((res, rej) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = img.width * k; c.height = img.height * k;
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url); res(c.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = rej; img.src = url;
  });
}

// ---------- Export / import ----------
function exportJSON() {
  return JSON.stringify({ app: 'pioche', version: 1, exportedAt: new Date().toISOString(), items: state.items }, null, 2);
}
async function importJSON(text) {
  const d = JSON.parse(text);
  const items = Array.isArray(d) ? d : d.items;
  if (!Array.isArray(items)) throw new Error('Format inconnu');
  const valid = items.filter(i => i && i.id && i.titre && i.categorie)
    .map(i => ({ liens: [], plateformes: [], statut: 'a_decouvrir', dateAjout: new Date().toISOString(), externalId: {}, ...i }));
  await db.putMany(valid); await reload();
  return valid.length;
}

// ---------- Câblage ----------
function syncSeg() {
  document.querySelectorAll('#status-seg button').forEach(b => b.classList.toggle('on', b.dataset.s === state.statut));
}
function bind() {
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
  // Fermer une feuille en touchant le fond
  document.querySelectorAll('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));

  $('#search').addEventListener('input', e => { state.q = e.target.value; renderList(); });
  $('#cat-chips').addEventListener('click', e => { const c = e.target.closest('[data-cat]'); if (c) { state.cat = c.dataset.cat; renderList(); } });
  $('#status-seg').addEventListener('click', e => { const b = e.target.closest('[data-s]'); if (b) { state.statut = b.dataset.s; syncSeg(); renderList(); } });
  $('#list').addEventListener('click', e => { const c = e.target.closest('.card'); if (c) openDetail(c.dataset.id); });

  $('#fab').addEventListener('click', openAdd);
  $('#add-cats').addEventListener('click', e => {
    const c = e.target.closest('[data-cat]'); if (!c) return;
    state.addCat = c.dataset.cat; renderAddCats(); runSearch(); $('#add-title').focus();
  });
  $('#add-title').addEventListener('input', runSearch);
  $('#add-title').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); if (!CATS[state.addCat].api) $('#add-manual').click(); } });
  $('#results').addEventListener('click', async e => {
    const li = e.target.closest('li[data-n]'); if (!li) return;
    const r = state.results[+li.dataset.n];
    $('#add-msg').textContent = 'Récupération des infos…';
    let data;
    try { data = await hydrate(state.addCat, r); }
    catch (err) { console.warn(err); data = { titre: r.titre, annee: r.annee, image: r.image }; }
    await addItem(newItem(state.addCat, data));
  });
  $('#add-manual').addEventListener('click', async () => {
    const titre = $('#add-title').value.trim();
    if (!titre) { $('#add-title').focus(); $('#add-msg').textContent = 'Saisissez un titre.'; return; }
    await addItem(newItem(state.addCat, { titre }));
  });

  $('#btn-edit').addEventListener('click', () => { $('#dlg-detail').close(); openEdit(state.current); });
  $('#btn-save').addEventListener('click', saveEdit);
  $('#edit-form').addEventListener('submit', e => { e.preventDefault(); saveEdit(); });
  $('#detail-body').addEventListener('click', async e => {
    const s = e.target.closest('#detail-statut [data-s]'); if (s) return setStatut(s.dataset.s);
    if (e.target.id === 'btn-delete') {
      if (!confirm(`Supprimer « ${state.current.titre} » ?`)) return;
      await db.del(state.current.id); $('#dlg-detail').close(); await reload(); toast('Supprimé');
    }
    if (e.target.id === 'btn-refresh') {
      const i = state.current; const [type, id] = i.externalId.tmdb.split('/');
      e.target.textContent = 'Actualisation…';
      try {
        const fresh = await hydrate(i.categorie, { _ref: { type, id }, titre: i.titre, annee: i.annee, image: i.image });
        const custom = (i.liens || []).filter(l => !fresh.liens.some(f => f.libelle === l.libelle) && !PLATFORM_SEARCH.some(([re]) => re.test(l.libelle)) && !/JustWatch|TMDB/.test(l.libelle));
        Object.assign(i, { plateformes: fresh.plateformes, plateformesMaj: fresh.plateformesMaj, liens: [...custom, ...fresh.liens] });
        await db.put(i); await reload(); openDetail(i.id); toast('Plateformes à jour');
      } catch (err) { e.target.textContent = 'Échec : ' + (err.message === 'NOKEY' ? 'clé TMDB manquante' : err.message); }
    }
  });

  // Réglages
  $('#btn-settings').addEventListener('click', async () => {
    $('#tmdb-key').value = settings.tmdb; $('#gbooks-key').value = settings.gbooks; $('#settings-msg').textContent = ''; $('#import-text').value = '';
    let info = `${state.items.length} élément(s).`;
    if (navigator.storage?.persisted) info += (await navigator.storage.persisted()) ? ' Stockage persistant ✓' : ' Stockage non garanti : exportez régulièrement.';
    $('#storage-info').textContent = info;
    $('#dlg-settings').showModal();
  });
  $('#tmdb-key').addEventListener('change', e => { settings.tmdb = e.target.value; toast('Clé enregistrée'); });
  $('#gbooks-key').addEventListener('change', e => { settings.gbooks = e.target.value; toast('Clé enregistrée'); });
  const smsg = t => ($('#settings-msg').textContent = t);
  $('#btn-export').addEventListener('click', async () => {
    const name = `pioche-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([exportJSON()], name, { type: 'application/json' });
    try {
      if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: 'Sauvegarde Pioche' }); smsg('Exporté.'); return; }
    } catch (e) { if (e.name === 'AbortError') return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000); smsg('Fichier téléchargé.');
  });
  $('#btn-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(exportJSON()); smsg('JSON copié dans le presse-papiers.'); }
    catch { $('#import-text').value = exportJSON(); smsg('Copie impossible : le JSON est dans la zone de texte.'); }
  });
  $('#import-file').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try { smsg(`${await importJSON(await f.text())} élément(s) importé(s).`); } catch (err) { smsg('Import impossible : ' + err.message); }
    e.target.value = '';
  });
  $('#btn-import-text').addEventListener('click', async () => {
    try { smsg(`${await importJSON($('#import-text').value)} élément(s) importé(s).`); } catch (err) { smsg('Import impossible : ' + err.message); }
  });
}

// V2 déjà prête : un Raccourci iOS peut ouvrir l'appli avec ?add=<titre ou url>
function handleAddParam() {
  const p = new URLSearchParams(location.search).get('add');
  if (!p) return;
  history.replaceState(null, '', location.pathname);
  openAdd();
  if (/^https?:\/\//i.test(p)) { state.addCat = 'spectacle'; renderAddCats(); $('#add-link').value = p; }
  else { $('#add-title').value = p; runSearch(); }
}

(async function init() {
  bind();
  await reload();
  handleAddParam();
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e));
})();
