const tabs = [...document.querySelectorAll('[role="tab"]')];
const tabStrip = document.querySelector(".tabs");
const motion = window.matchMedia("(prefers-reduced-motion: reduce)");

let activeTab = 0;

function selectTab(index, focus = false) {
  const direction = index < activeTab ? "-26px" : "26px";
  activeTab = index;
  tabStrip.style.setProperty("--tab", index);
  tabs.forEach((tab, position) => {
    const panel = document.getElementById(tab.getAttribute("aria-controls"));
    const selected = position === index;
    const entering = selected && panel.hidden;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    panel.style.setProperty("--page-direction", direction);
    panel.hidden = !selected;
    panel.classList.toggle("demo-panel-enter", entering && !motion.matches);
  });
  if (focus) tabs[index].focus({ preventScroll: true });
}

tabs.forEach((tab, index) => {
  tab.addEventListener("click", () => selectTab(index));
  tab.addEventListener("keydown", (event) => {
    let next = index;
    switch (event.key) {
      case "ArrowRight": next = (index + 1) % tabs.length; break;
      case "ArrowLeft": next = (index - 1 + tabs.length) % tabs.length; break;
      case "Home": next = 0; break;
      case "End": next = tabs.length - 1; break;
      default: return;
    }
    event.preventDefault();
    selectTab(next, true);
  });
});

document.querySelectorAll("[data-demo]").forEach((link) => {
  link.addEventListener("click", () => {
    const index = tabs.findIndex((tab) => tab.id === "tab-" + link.dataset.demo);
    if (index >= 0) selectTab(index, true);
  });
});

const progress = document.querySelector(".progress");
let frame = 0;
function updateProgress() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    const distance = document.documentElement.scrollHeight - innerHeight;
    progress.style.transform = "scaleX(" + (distance > 0 ? Math.min(1, Math.max(0, scrollY / distance)) : 0) + ")";
    updateTourFromScroll();
    frame = 0;
  });
}
addEventListener("scroll", updateProgress, { passive: true });
addEventListener("resize", updateProgress);
document.addEventListener("toggle", updateProgress, true);
updateProgress();

const capture = document.querySelector(".capture-frame");
if ("IntersectionObserver" in window && !motion.matches) {
  const observer = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return;
    capture.classList.add("in-view");
    observer.disconnect();
  }, { threshold: 0.16 });
  observer.observe(capture);
}

const tourScenes = [
  ["bilingual", "Read both versions together.", "Open the original and translated PDF in two native panes. Linked scrolling follows your reading position from either side.", "The English original and Chinese translation open in adjacent PDF panes"],
  ["translated", "Read in the translated layout.", "Translate one page or the whole paper. The translated view keeps text, figures, and tables in the PDF layout.", "The translated Chinese first page in Zotero"],
  ["word-palette", "Follow a term across languages.", "Select a phrase to see the matching text in the other pane. Save a highlight or underline with Zotero’s native palette.", "Matched selections for pangenome in both PDF panes with the native annotation palette"],
  ["independent", "Keep one pane in place.", "Switch to independent scrolling to check another page or a figure while keeping the passage you were reading visible.", "A figure open in the original pane while the translated pane remains on the first page"],
  ["navigation", "Jump from a result to its figure.", "Use the figure and table index to see captions and jump to an entry in the pane you choose.", "Zotero’s figure and table index with captions and a pane selector"],
  ["figure-export", "Inspect and export a figure.", "Open an independent preview. Zoom to read small labels, fit the figure to the window, or export a PNG.", "A figure in a separate preview with the PNG exported status"]
];

const tourButtons = [...document.querySelectorAll("[data-scene]")];
const tourChapterButtons = [...document.querySelectorAll("[data-chapter]")];
const tourWide = window.matchMedia("(min-width: 920px) and (min-height: 660px)");
const tour = document.querySelector(".reader-tour");
const tourDescription = document.getElementById("tour-description");
const tourImage = document.getElementById("tour-image");
const tourFrame = tourImage.parentElement;
const tourFull = document.getElementById("tour-full");
const tourTitle = document.getElementById("tour-title");
const tourText = document.getElementById("tour-text");
const tourCount = document.getElementById("tour-count");
let activeScene = 0;
let requestedScene = 0;
let requestId = 0;

async function showScene(index, announce = true) {
  const id = ++requestId;
  requestedScene = index;
  if (index === activeScene) return;
  const [file, title, description, alt] = tourScenes[index];
  const src = "assets/zotero-" + file + ".jpg";
  const next = new Image();
  next.src = src;
  try {
    await next.decode();
  } catch {
    if (id === requestId) {
      requestedScene = activeScene;
      tourText.textContent = "This capture could not load. Choose the feature again to retry.";
    }
    return;
  }
  if (id !== requestId) return;
  tourImage.classList.remove("scene-enter");
  tourImage.style.setProperty("--scene-direction", index < activeScene ? "-34px" : "34px");
  tourImage.src = src;
  tourImage.alt = alt;
  tourFull.href = src;
  tourDescription.setAttribute("aria-live", announce ? "polite" : "off");
  tourTitle.textContent = title;
  tourText.textContent = description;
  tourCount.textContent = (index + 1) + " / " + tourScenes.length;
  for (const controls of [tourButtons, tourChapterButtons]) {
    controls.forEach((button, position) => button.setAttribute("aria-pressed", String(position === index)));
  }
  activeScene = index;
  if (!motion.matches) {
    void tourFrame.offsetWidth;
    tourImage.classList.add("scene-enter");
  }
}

let manualTourUntil = 0;

function chooseScene(index) {
  showScene(index);
  if (!tourWide.matches) return;
  manualTourUntil = performance.now() + 1000;
  const chapter = tourChapterButtons[index].parentElement;
  const target = scrollY + chapter.getBoundingClientRect().top - innerHeight * .38 + 10;
  window.scrollTo({ top: target, behavior: motion.matches ? "instant" : "smooth" });
}

function updateTourFromScroll() {
  if (!tourWide.matches || motion.matches || performance.now() < manualTourUntil) return;
  const line = innerHeight * .38;
  const area = tour.getBoundingClientRect();
  if (area.top > line || area.bottom < line) return;
  let index = 0;
  for (const button of tourChapterButtons) {
    if (button.parentElement.getBoundingClientRect().top > line) break;
    index = Number(button.dataset.chapter);
  }
  if (index !== requestedScene) showScene(index, false);
}

addEventListener("wheel", () => { manualTourUntil = 0; }, { passive: true });
for (const controls of [tourButtons, tourChapterButtons]) {
  controls.forEach((button, index) => button.addEventListener("click", () => chooseScene(index)));
}
document.getElementById("tour-prev").addEventListener("click", () => chooseScene((requestedScene - 1 + tourScenes.length) % tourScenes.length));
document.getElementById("tour-next").addEventListener("click", () => chooseScene((requestedScene + 1) % tourScenes.length));

const film = document.getElementById("hero-video");
const filmButton = document.getElementById("film-toggle");
const filmProgress = document.getElementById("film-progress");
const filmScreen = film.closest(".film-screen");
const filmChapters = [...document.querySelectorAll("[data-film-start]")];
const filmStarts = filmChapters.map((button) => Number(button.dataset.filmStart));
let pendingFilmChapter = null;
let animateFilmSeek = false;
let manuallyPaused = false;
let filmVisible = false;

function syncFilm() {
  filmButton.toggleAttribute("data-playing", !film.paused);
  const label = film.ended ? "Replay demo" : film.paused ? "Play demo" : "Pause demo";
  filmButton.setAttribute("aria-label", label);
  filmButton.title = label;
}
function updateFilm() {
  if (filmVisible && !film.ended && !motion.matches && !manuallyPaused && !document.hidden) {
    film.play().catch(syncFilm);
  } else {
    film.pause();
  }
}
filmButton.disabled = false;
function filmUnavailable() {
  filmButton.disabled = true;
  filmButton.removeAttribute("data-playing");
  filmButton.setAttribute("aria-label", "Demo unavailable");
  filmChapters.forEach((button) => { button.disabled = true; });
}
film.addEventListener("error", filmUnavailable);
film.querySelector("source").addEventListener("error", filmUnavailable);
filmButton.addEventListener("click", () => {
  manuallyPaused = !film.paused;
  if (manuallyPaused) film.pause();
  else {
    if (film.ended) film.currentTime = 0;
    film.play().catch(syncFilm);
  }
});
function showFilmChapter(index) {
  filmChapters.forEach((button, position) => button.setAttribute("aria-pressed", String(index === position)));
}

function seekFilmChapter() {
  if (pendingFilmChapter === null) return;
  const start = filmStarts[pendingFilmChapter];
  pendingFilmChapter = null;
  if (Math.abs(film.currentTime - start) < .04) return;
  animateFilmSeek = true;
  film.currentTime = start;
}

filmChapters.forEach((button, index) => button.addEventListener("click", () => {
  pendingFilmChapter = index;
  showFilmChapter(index);
  if (film.readyState === 0) film.load();
  else seekFilmChapter();
}));
film.addEventListener("loadedmetadata", seekFilmChapter);
film.addEventListener("seeked", () => {
  if (!animateFilmSeek) return;
  animateFilmSeek = false;
  if (motion.matches) return;
  filmScreen.classList.remove("chapter-change");
  void filmScreen.offsetWidth;
  filmScreen.classList.add("chapter-change");
});
film.addEventListener("play", syncFilm);
film.addEventListener("pause", syncFilm);
film.addEventListener("ended", syncFilm);
film.addEventListener("timeupdate", () => {
  filmProgress.value = Number.isFinite(film.duration) && film.duration > 0 ? film.currentTime / film.duration : 0;
  if (!film.seeking && pendingFilmChapter === null) {
    showFilmChapter(filmStarts.findLastIndex((start) => film.currentTime >= start));
  }
});
document.addEventListener("visibilitychange", updateFilm);
motion.addEventListener("change", updateFilm);
if ("IntersectionObserver" in window) {
  new IntersectionObserver(([entry]) => {
    filmVisible = entry.isIntersecting && entry.intersectionRatio >= .18;
    updateFilm();
  }, { threshold: .18 }).observe(film);
}

if ("IntersectionObserver" in window && !motion.matches) {
  const exhibitObserver = new IntersectionObserver((entries) => {
    entries.filter((entry) => entry.isIntersecting).forEach((entry) => {
      entry.target.classList.add("section-in");
      exhibitObserver.unobserve(entry.target);
    });
  }, { threshold: .22 });
  document.querySelectorAll(".writing figure, .walkthrough-media, .app-list").forEach((element) => exhibitObserver.observe(element));
}

const walkthrough = document.getElementById("walkthrough-video");
let walkthroughVisible = false;
let walkthroughPausedByUser = false;

function updateWalkthrough() {
  if (walkthroughVisible && !document.hidden && !motion.matches && !walkthroughPausedByUser && !walkthrough.ended) {
    walkthrough.play().catch(() => {});
  } else if (!walkthroughVisible || document.hidden || motion.matches) {
    walkthrough.pause();
  }
}

walkthrough.addEventListener("pause", () => {
  if (walkthroughVisible && !document.hidden && !motion.matches && !walkthrough.ended) {
    walkthroughPausedByUser = true;
  }
});
walkthrough.addEventListener("play", () => { walkthroughPausedByUser = false; });
document.addEventListener("visibilitychange", updateWalkthrough);
motion.addEventListener("change", updateWalkthrough);
if ("IntersectionObserver" in window) {
  new IntersectionObserver(([entry]) => {
    walkthroughVisible = entry.isIntersecting && entry.intersectionRatio >= .35;
    updateWalkthrough();
  }, { threshold: .35 }).observe(walkthrough);
}
