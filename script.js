const pdfPath = "photobook.pdf";

const track = document.getElementById("track");
const loading = document.getElementById("loading");
const errorBox = document.getElementById("error");
const prevBtn = document.getElementById("prev");
const nextBtn = document.getElementById("next");
const fullscreenBtn = document.getElementById("fullscreen");
const zoomInBtn = document.getElementById("zoomIn");
const zoomOutBtn = document.getElementById("zoomOut");
const counter = document.getElementById("counter");

let currentView = 0;
let numViews = 0;
let numPages = 0;
let views = []; // each entry: { el, inner, scale, tx, ty }
let pageImgEls = []; // img elements indexed by page number (0-based)

const MIN_SCALE = 1;
const MAX_SCALE = 4;

pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

window.addEventListener("load", init);

async function init() {
    try {
        const pdf = await pdfjsLib.getDocument(pdfPath).promise;
        numPages = pdf.numPages;

        // Group into views by page index: page 1 alone (cover), then spreads of 2
        const groups = [];
        if (numPages > 0) {
            groups.push([0]);
            for (let i = 1; i < numPages; i += 2) {
                const pair = [i];
                if (i + 1 < numPages) pair.push(i + 1);
                groups.push(pair);
            }
        }

        await buildViews(pdf, groups);
        fitAllViews();

        // Render just page 1 first so the reader can start immediately
        await renderPageInto(pdf, 0);

        loading.style.display = "none";
        setupControls();
        goToView(0);

        window.addEventListener("resize", fitAllViews);
        document.addEventListener("fullscreenchange", fitAllViews);

        // Render the remaining pages in the background, in reading order
        renderRemainingPages(pdf, groups);
    } catch (err) {
        console.error("Failed to load photobook:", err);
        loading.style.display = "none";
        errorBox.style.display = "grid";
        errorBox.textContent =
            "Failed to load photobook.pdf\n\n" +
            (err && err.message ? err.message : err) +
            "\n\nCheck that photobook.pdf is in the same folder and that you're " +
            "serving this over http:// (not opening the file directly).";
    }
}

async function buildViews(pdf, groups) {
    numViews = groups.length;
    track.style.width = `${numViews * 100}vw`;

    for (const group of groups) {
        const viewEl = document.createElement("div");
        viewEl.className = "view";

        const innerEl = document.createElement("div");
        innerEl.className = "view-inner";
        innerEl.style.transformOrigin = "0 0";

        // Get each page's real dimensions (cheap: no rendering, just metadata)
        // to set an exact aspect ratio for this view — a spread's ratio is
        // (sum of page widths) : (max page height).
        let totalWidth = 0;
        let maxHeight = 0;
        for (const pageIndex of group) {
            const page = await pdf.getPage(pageIndex + 1);
            const viewport = page.getViewport({ scale: 1 });
            totalWidth += viewport.width;
            maxHeight = Math.max(maxHeight, viewport.height);
        }
        const ratio = totalWidth / maxHeight;

        group.forEach((pageIndex) => {
            const half = document.createElement("div");
            half.className = "page-half";
            if (group.length === 1) half.classList.add("single");

            const img = document.createElement("img");
            img.draggable = false;

            half.appendChild(img);
            innerEl.appendChild(half);
            pageImgEls[pageIndex] = img;
        });

        viewEl.appendChild(innerEl);
        track.appendChild(viewEl);

        views.push({ el: viewEl, inner: innerEl, scale: 1, tx: 0, ty: 0, ratio });
    }
}

function fitView(v) {
    const containerW = window.innerWidth;
    const containerH = window.innerHeight;
    const containerRatio = containerW / containerH;

    let w, h;
    if (v.ratio > containerRatio) {
        // image spread is wider (relatively) than the viewport -> fit to width
        w = containerW;
        h = containerW / v.ratio;
    } else {
        // image spread is taller (relatively) than the viewport -> fit to height
        h = containerH;
        w = containerH * v.ratio;
    }

    v.inner.style.width = `${w}px`;
    v.inner.style.height = `${h}px`;
}

function fitAllViews() {
    views.forEach(fitView);
}

async function renderPageInto(pdf, pageIndex) {
    const page = await pdf.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: ctx, viewport }).promise;
    pageImgEls[pageIndex].src = canvas.toDataURL("image/jpeg", 0.85);
}

async function renderRemainingPages(pdf, groups) {
    for (const group of groups) {
        for (const pageIndex of group) {
            if (pageIndex === 0) continue; // already rendered
            await renderPageInto(pdf, pageIndex);
        }
    }
}

function setupControls() {
    prevBtn.addEventListener("click", () => goToView(currentView - 1));
    nextBtn.addEventListener("click", () => goToView(currentView + 1));
    fullscreenBtn.addEventListener("click", toggleFullscreen);
    zoomInBtn.addEventListener("click", () => zoomBy(1.5, centerPoint()));
    zoomOutBtn.addEventListener("click", () => zoomBy(1 / 1.5, centerPoint()));

    document.addEventListener("keydown", (e) => {
        const v = views[currentView];
        if (e.key === "ArrowLeft" && v.scale === 1) goToView(currentView - 1);
        if (e.key === "ArrowRight" && v.scale === 1) goToView(currentView + 1);
        if (e.key === "+" || e.key === "=") zoomBy(1.3, centerPoint());
        if (e.key === "-" || e.key === "_") zoomBy(1 / 1.3, centerPoint());
        if (e.key === "0") resetZoom(views[currentView]);
    });

    // Wheel: zoom (ctrl/cmd + wheel, or plain wheel with deltaY) zoomed to cursor
    track.addEventListener("wheel", (e) => {
        e.preventDefault();
        const point = { x: e.clientX, y: e.clientY };
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        zoomBy(factor, point);
    }, { passive: false });

    // Double click to toggle zoom
    track.addEventListener("dblclick", (e) => {
        const v = views[currentView];
        if (v.scale > 1) {
            resetZoom(v);
        } else {
            zoomBy(2.5, { x: e.clientX, y: e.clientY });
        }
    });

    // Drag to pan (only meaningful when zoomed); swipe to navigate when not zoomed
    let dragging = false;
    let dragStart = { x: 0, y: 0 };
    let startTranslate = { x: 0, y: 0 };
    let swipeStartX = null;

    track.addEventListener("pointerdown", (e) => {
        const v = views[currentView];
        dragging = true;
        dragStart = { x: e.clientX, y: e.clientY };
        startTranslate = { x: v.tx, y: v.ty };
        swipeStartX = e.clientX;
        track.setPointerCapture(e.pointerId);
    });

    track.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const v = views[currentView];
        if (v.scale > 1) {
            const dx = e.clientX - dragStart.x;
            const dy = e.clientY - dragStart.y;
            setTranslate(v, startTranslate.x + dx, startTranslate.y + dy);
        }
    });

    track.addEventListener("pointerup", (e) => {
        if (!dragging) return;
        dragging = false;
        const v = views[currentView];
        if (v.scale === 1 && swipeStartX !== null) {
            const dx = e.clientX - swipeStartX;
            if (Math.abs(dx) > 60) {
                if (dx < 0) goToView(currentView + 1);
                else goToView(currentView - 1);
            }
        }
        swipeStartX = null;
    });

    track.addEventListener("pointercancel", () => {
        dragging = false;
        swipeStartX = null;
    });

    // Pinch to zoom (touch)
    let pinchStartDist = null;
    let pinchStartScale = 1;
    track.addEventListener("touchstart", (e) => {
        if (e.touches.length === 2) {
            pinchStartDist = touchDistance(e.touches);
            pinchStartScale = views[currentView].scale;
        }
    }, { passive: true });

    track.addEventListener("touchmove", (e) => {
        if (e.touches.length === 2 && pinchStartDist) {
            e.preventDefault();
            const dist = touchDistance(e.touches);
            const factor = dist / pinchStartDist;
            const v = views[currentView];
            const mid = {
                x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
                y: (e.touches[0].clientY + e.touches[1].clientY) / 2
            };
            setScaleAtPoint(v, clamp(pinchStartScale * factor, MIN_SCALE, MAX_SCALE), mid);
        }
    }, { passive: false });

    track.addEventListener("touchend", (e) => {
        if (e.touches.length < 2) pinchStartDist = null;
    });
}

function touchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
}

function centerPoint() {
    return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}

function zoomBy(factor, point) {
    const v = views[currentView];
    const newScale = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
    setScaleAtPoint(v, newScale, point);
}

function setScaleAtPoint(v, newScale, point) {
    const rect = v.el.getBoundingClientRect();
    const px = point.x - rect.left;
    const py = point.y - rect.top;

    // Keep the point under the cursor/fingers stationary while zooming
    const contentX = (px - v.tx) / v.scale;
    const contentY = (py - v.ty) / v.scale;

    v.scale = newScale;
    const newTx = px - contentX * v.scale;
    const newTy = py - contentY * v.scale;

    setTranslate(v, newTx, newTy, rect);
}

function setTranslate(v, tx, ty, rect) {
    rect = rect || v.el.getBoundingClientRect();
    const scaledW = rect.width * v.scale;
    const scaledH = rect.height * v.scale;

    const minX = Math.min(0, rect.width - scaledW);
    const maxX = 0;
    const minY = Math.min(0, rect.height - scaledH);
    const maxY = 0;

    v.tx = v.scale === 1 ? 0 : clamp(tx, minX, maxX);
    v.ty = v.scale === 1 ? 0 : clamp(ty, minY, maxY);

    applyTransform(v);
}

function applyTransform(v) {
    v.inner.style.transform = `translate(${v.tx}px, ${v.ty}px) scale(${v.scale})`;
    v.el.classList.toggle("zoomed", v.scale > 1);
}

function resetZoom(v) {
    v.scale = 1;
    v.tx = 0;
    v.ty = 0;
    applyTransform(v);
}

function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
}

function goToView(index) {
    if (index < 0 || index >= numViews) return;
    resetZoom(views[currentView]);
    currentView = index;
    track.style.transform = `translateX(-${currentView * 100}vw)`;
    counter.textContent = `${currentView + 1} / ${numViews}`;
    prevBtn.disabled = currentView === 0;
    nextBtn.disabled = currentView === numViews - 1;
}

function toggleFullscreen() {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen();
    } else {
        document.exitFullscreen();
    }
}