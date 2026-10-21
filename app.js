(function () {
  var INTERVAL = 2500;           // ms between photos
  var TRANS = 1100;              // ms the outgoing photo takes to zoom past
  var DRIFT = INTERVAL + TRANS + 400; // each photo keeps moving the whole time it's visible
  var REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var media = window.LMC_PHOTOS || [];
  var $ = function (id) { return document.getElementById(id); };

  // Slideshow: photos only, rotating through categories so it stays varied
  var photos = (function () {
    var byCat = {}, order = [];
    media.forEach(function (m) {
      if (m.type === 'video') return;
      if (!byCat[m.cat]) { byCat[m.cat] = []; order.push(m.cat); }
      byCat[m.cat].push(m);
    });
    var out = [], left = true;
    for (var r = 0; left; r++) {
      left = false;
      order.forEach(function (c) { if (byCat[c][r]) { out.push(byCat[c][r]); left = true; } });
    }
    return out;
  })();

  // ---------- Slideshow ----------
  var show = $('show'), slidesEl = $('slides'), counter = $('counter'), catLabel = $('catLabel');
  var progress = $('progress'), playBtn = $('playPause');
  var slideEls = [], cur = -1, timer = null, playing = true, req = 0;

  if (!photos.length) {
    // No photos yet: play the Evophoria cover film in the frame instead
    $('showFallback').hidden = false;
    $('showFallbackBd').hidden = false;
    $('showControls').hidden = true;
    $('prev').hidden = $('next').hidden = true;
    progress.parentNode.hidden = true;
  } else {
    photos.forEach(function (p, i) {
      var s = document.createElement('div');
      s.className = 'slide';
      s.setAttribute('aria-roledescription', 'slide');
      slidesEl.appendChild(s);
      slideEls.push(s);
    });
    go(0);
  }

  // Build a slide's contents only when it's about to be shown, and drop it when far away
  function fill(i) {
    var s = slideEls[i];
    if (s.firstChild) return s.querySelector('img');
    var p = photos[i];
    var bd = document.createElement('div');
    bd.className = 'backdrop';
    bd.style.backgroundImage = 'url("' + (p.thumb || p.src) + '")';
    var img = document.createElement('img');
    img.alt = p.alt || 'Evophoria — The Luxurious Marble Circus';
    img.decoding = 'async';
    img.src = p.src;
    s.appendChild(bd); s.appendChild(img);
    return img;
  }
  function unfillFar() {
    var n = photos.length;
    slideEls.forEach(function (s, i) {
      var d = Math.min(Math.abs(i - cur), n - Math.abs(i - cur));
      if (d > 2 && s.firstChild && !s.classList.contains('on')) s.innerHTML = '';
    });
  }

  // Size the photo to the frame and give it its own slow camera move
  function animateDrift(i) {
    var s = slideEls[i], img = s.querySelector('img'), p = photos[i];
    var W = show.clientWidth, H = show.clientHeight;
    var ar = (p.w && p.h) ? p.w / p.h : (img.naturalWidth / img.naturalHeight || 1.5);
    var r = ar / (W / H);
    var cover = r > 0.55 && r < 2.6; // fill the frame unless the shapes are wildly different
    var w, h;
    if (cover === (ar > W / H)) { h = H; w = H * ar; } else { w = W; h = W / ar; }
    img.style.width = w + 'px';
    img.style.height = h + 'px';
    s.querySelector('.backdrop').style.display = cover ? 'none' : '';

    var sx = Math.random() < 0.5 ? 1 : -1, sy = Math.random() < 0.5 ? 1 : -1;
    var ox = Math.max(0, (w - W) / 2), oy = Math.max(0, (h - H) / 2);
    var x0, y0, s0, s1;
    if (cover) {
      x0 = sx * (ox * 0.85 + W * 0.015);
      y0 = sy * (oy * 0.6 + H * 0.012);
      s0 = 1.04; s1 = 1.14;
    } else {
      x0 = sx * W * 0.01; y0 = sy * H * 0.01;
      s0 = 1; s1 = 1.08;
    }
    var base = 'translate(-50%, -50%) ';
    if (img._drift) img._drift.cancel();
    if (REDUCED) { img.style.transform = base + 'scale(' + s0 + ')'; return; }
    img._drift = img.animate([
      { transform: base + 'translate(' + x0 + 'px,' + y0 + 'px) scale(' + s0 + ')' },
      { transform: base + 'translate(' + (-x0) + 'px,' + (-y0) + 'px) scale(' + s1 + ')' }
    ], { duration: DRIFT, easing: 'linear', fill: 'forwards' });
  }

  function ready(img) {
    if (img.complete && img.naturalWidth) return Promise.resolve();
    var wait = img.decode ? img.decode() : new Promise(function (res) { img.onload = res; });
    return Promise.race([wait.catch(function () {}), new Promise(function (res) { setTimeout(res, 2500); })]);
  }

  function go(i) {
    var n = photos.length;
    i = (i + n) % n;
    if (i === cur) return;
    var my = ++req; // a newer request (tap, swipe, timer) supersedes this one
    clearTimeout(timer);
    var img = fill(i);
    fill((i + 1) % n); // preload the next one

    ready(img).then(function () {
      if (my !== req) return;
      var next = slideEls[i], prev = cur >= 0 ? slideEls[cur] : null;
      next.getAnimations().forEach(function (an) { an.cancel(); });
      next.style.zIndex = 1;
      next.classList.add('on');
      animateDrift(i);

      if (prev) {
        // The outgoing photo flies forward past the camera and dissolves,
        // revealing the next one already in motion underneath
        prev.style.zIndex = 2;
        var exit = REDUCED
          ? prev.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 400, fill: 'forwards' })
          : prev.animate([
              { opacity: 1, transform: 'scale(1)', filter: 'blur(0px)' },
              { opacity: 1, transform: 'scale(1.08)', filter: 'blur(0px)', offset: 0.25 },
              { opacity: 0, transform: 'scale(1.32)', filter: 'blur(6px)' }
            ], { duration: TRANS, easing: 'cubic-bezier(.5,0,.75,.4)', fill: 'forwards' });
        exit.onfinish = function () {
          if (prev === slideEls[cur]) return; // it came back on screen mid-transition
          prev.classList.remove('on');
          prev.style.zIndex = '';
          exit.cancel();
          unfillFar();
        };
      } else if (!REDUCED) {
        next.animate([{ opacity: 0, transform: 'scale(1.06)' }, { opacity: 1, transform: 'scale(1)' }],
                     { duration: 900, easing: 'ease-out' });
      }

      cur = i;
      counter.textContent = pad(i + 1) + ' / ' + pad(n);
      catLabel.textContent = photos[i].cat || '';
      schedule();
    });
  }
  function pad(x) { return (x < 10 ? '0' : '') + x; }

  function schedule() {
    clearTimeout(timer);
    progress.style.transition = 'none';
    progress.style.width = '0';
    if (!playing || photos.length < 2) return;
    progress.offsetWidth; // reflow so the transition restarts
    progress.style.transition = 'width ' + INTERVAL + 'ms linear';
    progress.style.width = '100%';
    timer = setTimeout(function () { go(cur + 1); }, INTERVAL);
  }
  function setPlaying(v) {
    playing = v;
    playBtn.textContent = v ? 'Pause' : 'Play';
    playBtn.setAttribute('aria-label', v ? 'Pause slideshow' : 'Play slideshow');
    slideEls.forEach(function (s) {
      var im = s.querySelector('img');
      if (im && im._drift) v ? im._drift.play() : im._drift.pause();
    });
    schedule();
  }

  playBtn.addEventListener('click', function () { setPlaying(!playing); });
  $('prev').addEventListener('click', function () { go(cur - 1); });
  $('next').addEventListener('click', function () { go(cur + 1); });
  slidesEl.addEventListener('click', function () {
    if (photos.length) openLB(media.indexOf(photos[cur]));
  });

  // Swipe on the slideshow
  var sx0 = null;
  show.addEventListener('touchstart', function (e) { sx0 = e.touches[0].clientX; }, { passive: true });
  show.addEventListener('touchend', function (e) {
    if (sx0 === null || !photos.length) return;
    var dx = e.changedTouches[0].clientX - sx0;
    if (Math.abs(dx) > 40) go(cur + (dx < 0 ? 1 : -1));
    sx0 = null;
  });

  // Re-fit the current photo when the window changes size
  var rt;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () { if (cur >= 0) animateDrift(cur); }, 150);
  });

  // Pause while the tab is hidden
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) clearTimeout(timer); else schedule();
  });

  // ---------- Collection grid ----------
  var grid = $('grid'), filters = $('filters'), tiles = [];
  if (!media.length) $('empty').hidden = false;

  var cats = [];
  media.forEach(function (m) { if (cats.indexOf(m.cat) < 0) cats.push(m.cat); });
  if (cats.length > 1) {
    ['All'].concat(cats).forEach(function (c) {
      var f = document.createElement('button');
      f.textContent = c;
      f.className = c === 'All' ? 'active' : '';
      f.addEventListener('click', function () {
        [].forEach.call(filters.children, function (x) { x.classList.toggle('active', x === f); });
        tiles.forEach(function (t) { t.hidden = c !== 'All' && t.dataset.cat !== c; });
      });
      filters.appendChild(f);
    });
  }

  media.forEach(function (m, i) {
    var b = document.createElement('button');
    b.dataset.cat = m.cat;
    tiles.push(b);
    b.className = 'tile' + (m.type === 'video' ? ' video' : '');
    b.setAttribute('aria-label', 'Open ' + (m.type === 'video' ? 'video ' : 'photo ') + (i + 1));
    var img = document.createElement('img');
    img.loading = 'lazy'; img.decoding = 'async'; img.alt = '';
    if (m.w && m.h) { img.width = m.w; img.height = m.h; }
    img.onload = function () { img.classList.add('loaded'); };
    img.src = m.thumb || m.poster || m.src;
    b.appendChild(img);
    b.addEventListener('click', function () { openLB(i); });
    grid.appendChild(b);
  });

  // ---------- Lightbox ----------
  var lb = $('lightbox'), lbMedia = $('lbMedia'), lbCur = 0, wasPlaying = true;

  function visible() {
    return media.map(function (_, i) { return i; }).filter(function (i) { return !tiles[i] || !tiles[i].hidden; });
  }
  function step(d) {
    var v = visible(), k = v.indexOf(lbCur);
    showLB(v[(k + d + v.length) % v.length]);
  }
  function showLB(i) {
    lbCur = (i + media.length) % media.length;
    var m = media[lbCur];
    lbMedia.innerHTML = '';
    var el;
    if (m.type === 'video') {
      el = document.createElement('video');
      el.src = m.src; el.controls = true; el.autoplay = true; el.playsInline = true;
      if (m.thumb) el.poster = m.thumb;
    } else {
      el = document.createElement('img');
      el.src = m.src; el.alt = m.alt || '';
    }
    lbMedia.appendChild(el);
    var v = visible();
    $('lbCount').textContent = (v.indexOf(lbCur) + 1) + ' / ' + v.length;
    $('lbDownload').href = m.src;
  }
  function openLB(i) {
    wasPlaying = playing;
    if (playing) setPlaying(false);
    showLB(i);
    lb.hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeLB() {
    lb.hidden = true;
    lbMedia.innerHTML = '';
    document.body.style.overflow = '';
    if (wasPlaying) setPlaying(true);
  }

  $('lbClose').onclick = closeLB;
  $('lbPrev').onclick = function () { step(-1); };
  $('lbNext').onclick = function () { step(1); };
  lb.addEventListener('click', function (e) { if (e.target === lb || e.target === lbMedia) closeLB(); });

  document.addEventListener('keydown', function (e) {
    if (!lb.hidden) {
      if (e.key === 'Escape') closeLB();
      if (e.key === 'ArrowRight') step(1);
      if (e.key === 'ArrowLeft') step(-1);
    } else if (photos.length && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
      if (e.key === 'ArrowRight') go(cur + 1);
      if (e.key === 'ArrowLeft') go(cur - 1);
    }
  });

  var lx = null;
  lb.addEventListener('touchstart', function (e) { lx = e.touches[0].clientX; }, { passive: true });
  lb.addEventListener('touchend', function (e) {
    if (lx === null) return;
    var dx = e.changedTouches[0].clientX - lx;
    if (Math.abs(dx) > 40) step(dx < 0 ? 1 : -1);
    lx = null;
  });
})();
