const FAVORITES_KEY = "mlr-favorites";
const EDITOR_KEY = "mlr-editor";

const state = {
  ready: false,
  recipes: [],
  categories: ["Varmrätt", "Förrätt", "Soppa", "Bakverk", "Efterrätt", "Fika"],
  yieldUnits: ["portioner", "bitar", "bullar", "bollar", "stycken"],
  addresses: [],
  query: "",
  category: "Alla",
  servings: {},
  loadError: "",
};

const singular = {
  portioner: "portion",
  bitar: "bit",
  bullar: "bulle",
  bollar: "boll",
  stycken: "stycke",
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character]));
}

function favorites() {
  try {
    const stored = JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]");
    return new Set(Array.isArray(stored) ? stored : []);
  } catch {
    return new Set();
  }
}

function toggleFavorite(id) {
  const saved = favorites();
  if (saved.has(id)) saved.delete(id);
  else saved.add(id);
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([...saved]));
  } catch {
    /* This browser is keeping the book open without local storage. */
  }
}

function sorted(list = state.recipes) {
  return [...list].sort((a, b) => a.title.localeCompare(b.title, "sv"));
}

function numberFor(id) {
  const index = sorted().findIndex((recipe) => recipe.id === id);
  return String(Math.max(index, 0) + 1).padStart(2, "0");
}

function formatTime(minutes) {
  if (minutes >= 1440) {
    const days = Math.round(minutes / 1440);
    return days === 1 ? "1 dygn" : `${days} dygn`;
  }
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    const hourLabel = hours === 1 ? "1 timme" : `${hours} timmar`;
    return rest ? `${hours} tim ${rest} min` : hourLabel;
  }
  return `${minutes} min`;
}

function yieldName(count, unit) {
  if (count === 1 && singular[unit]) return singular[unit];
  return unit || "portioner";
}

function formatQty(qty) {
  if (qty == null || qty === "") return "";
  const number = Number(qty);
  if (!Number.isFinite(number)) return "";
  const whole = Math.floor(number + 1e-8);
  const fraction = number - whole;
  const glyphs = [[0.25, "¼"], [1 / 3, "⅓"], [0.5, "½"], [2 / 3, "⅔"], [0.75, "¾"]];
  for (const [value, glyph] of glyphs) {
    if (Math.abs(fraction - value) < 0.03) {
      return whole === 0 ? glyph : `${whole}${glyph}`;
    }
  }
  const rounded = Math.round(number * 100) / 100;
  const text = Number.isInteger(rounded)
    ? String(rounded)
    : rounded.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return text.replace(".", ",");
}

function amountText(ingredient, factor) {
  if (ingredient.qty == null) return "";
  const qty = formatQty(Number(ingredient.qty) * factor);
  return [qty, ingredient.unit].filter(Boolean).join(" ");
}

function safeSrc(src) {
  return typeof src === "string" && (src.startsWith("/images/") || src.startsWith("/uploads/")) ? src : "";
}

function parseRoute() {
  const path = location.pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return { name: "home" };
  if (path === "/nytt") return { name: "edit", id: null };
  let match = path.match(/^\/recept\/([a-z0-9-]+)$/);
  if (match) return { name: "recipe", id: match[1] };
  match = path.match(/^\/redigera\/([a-z0-9-]+)$/);
  if (match) return { name: "edit", id: match[1] };
  return { name: "missing" };
}

function listUrl() {
  const params = new URLSearchParams();
  if (state.query) params.set("q", state.query);
  if (state.category !== "Alla") params.set("kat", state.category);
  const search = params.toString();
  return search ? `/?${search}` : "/";
}

function readUrl() {
  const params = new URLSearchParams(location.search);
  state.query = params.get("q") || "";
  const category = params.get("kat") || "Alla";
  const known = new Set(["Alla", "Sparade", ...state.categories]);
  state.category = known.has(category) ? category : "Alla";
  const input = document.querySelector("#q");
  if (input && document.activeElement !== input && input.value !== state.query) {
    input.value = state.query;
  }
}

function filtered() {
  const query = state.query.trim().toLowerCase();
  const saved = favorites();
  return sorted().filter((recipe) => {
    if (state.category === "Sparade" && !saved.has(recipe.id)) return false;
    if (state.category !== "Alla" && state.category !== "Sparade" && recipe.category !== state.category) return false;
    if (!query) return true;
    const haystack = [
      recipe.title,
      recipe.summary,
      recipe.note,
      recipe.category,
      recipe.credit,
      ...(recipe.ingredients || []).map((item) => item.item),
      ...(recipe.steps || []),
    ].join(" ").toLowerCase();
    return haystack.includes(query);
  });
}

function heartIcon() {
  return '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 20s-7-4.4-7-9a4 4 0 0 1 7-2 4 4 0 0 1 7 2c0 4.6-7 9-7 9z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"></path></svg>';
}

function heartButton(recipe, onPaper) {
  const saved = favorites().has(recipe.id);
  const label = saved ? `Ta bort ${recipe.title} från sparade` : `Spara ${recipe.title}`;
  return `<button type="button" class="heart${onPaper ? " on-paper" : ""}" data-fav="${esc(recipe.id)}" aria-pressed="${saved}" aria-label="${esc(label)}">${heartIcon()}</button>`;
}

function photo(recipe, className, lazy = false) {
  const src = safeSrc(recipe.image);
  const letter = esc(recipe.title.slice(0, 1));
  if (!src) return `<div class="${className} photo-fallback" aria-hidden="true">${letter}</div>`;
  return `<img class="${className}" src="${esc(src)}" alt="${esc(recipe.title)}" data-letter="${letter}" ${lazy ? 'loading="lazy"' : ""}>`;
}

function photoFrame(recipe) {
  const src = safeSrc(recipe.image);
  if (!src) return `<div class="frame">${photo(recipe, "")}</div>`;
  return `<button type="button" class="frame zoom-photo" data-zoom aria-label="Visa bilden stort">${photo(recipe, "")}</button>`;
}

function editorToken() {
  return sessionStorage.getItem(EDITOR_KEY) || "";
}

function authHeaders() {
  const headers = { "Content-Type": "application/json" };
  const token = editorToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function card(recipe) {
  return `<article class="card">
    ${heartButton(recipe)}
    <a class="card-link" href="/recept/${esc(recipe.id)}">
      <div class="card-photo">${photo(recipe, "", true)}</div>
      <div class="card-body">
        <p class="kicker"><span>${esc(recipe.category)}</span><span>Nr ${numberFor(recipe.id)}</span></p>
        <h2>${esc(recipe.title)}</h2>
        <p class="meta">${esc(formatTime(recipe.minutes))} · ${esc(recipe.servings)} ${esc(yieldName(recipe.servings, recipe.yieldUnit))}</p>
      </div>
    </a>
  </article>`;
}

function homeView() {
  if (state.loadError) return `<div class="page"><p class="empty">${esc(state.loadError)}</p></div>`;
  const matches = filtered();
  const cover = state.recipes.find((recipe) => recipe.featured) || sorted()[0];
  const showSpread = !state.query.trim() && state.category === "Alla" && cover;
  const list = matches;
  const count = matches.length === 1 ? "1 recept" : `${matches.length} recept`;
  let body = `<header class="intro">
      <p class="kicker"><span>Familjens kokbok</span></p>
      <h1>Vad blir det idag?</h1>
      <p class="lede">Bläddra bland recepten, titta på bilderna och räkna om mängderna. Det ni lägger till syns för hela familjen.</p>
    </header>`;
  if (showSpread) {
    body += `<article class="spread">
      <a class="spread-photo" href="/recept/${esc(cover.id)}">${photo(cover, "")}</a>
      <div>
        <p class="kicker"><span>Ur boken</span><span>${esc(cover.category)}</span></p>
        <h2 class="spread-title">${esc(cover.title)}</h2>
        <p class="lede">${esc(cover.summary || "")}</p>
        <p class="meta">${esc(formatTime(cover.minutes))} · ${esc(cover.servings)} ${esc(yieldName(cover.servings, cover.yieldUnit))}</p>
        <p class="toolbar"><a class="btn" href="/recept/${esc(cover.id)}">Öppna receptet</a></p>
      </div>
    </article>`;
  }
  const chips = ["Alla", ...state.categories, "Sparade"].map((category) => {
    const pressed = state.category === category;
    return `<button type="button" class="chip" data-cat="${esc(category)}" aria-pressed="${pressed}">${esc(category)}</button>`;
  }).join("");
  body += `<div class="index-head"><h2>I boken</h2><p class="meta" aria-live="polite">${count}</p></div>
    <div class="filters" role="group" aria-label="Kategorier">${chips}</div>`;
  if (!matches.length) {
    const message = state.category === "Sparade"
      ? "Inga sparade recept än. Hjärtat på ett recept stannar i den här webbläsaren."
      : `Inget recept matchar «${state.query.trim() || state.category}».`;
    body += `<div class="empty"><h2>Inget recept här</h2><p>${esc(message)}</p></div>`;
  } else if (list.length) {
    body += `<div class="grid">${list.map(card).join("")}</div>`;
  }
  return `<div class="page">${body}</div>`;
}

function recipeView(id) {
  const recipe = state.recipes.find((item) => item.id === id);
  if (!recipe) {
    return `<div class="page"><h1>Det receptet är borta</h1><p><a href="/">Tillbaka till recepten</a></p></div>`;
  }
  const current = state.servings[recipe.id] ?? recipe.servings;
  const factor = current / recipe.servings;
  const ingredients = recipe.ingredients.map((ingredient) => {
    return `<li><span class="amt">${esc(amountText(ingredient, factor))}</span><span>${esc(ingredient.item)}</span></li>`;
  }).join("");
  const steps = recipe.steps.map((step) => `<li><p>${esc(step)}</p></li>`).join("");
  const photoHref = typeof recipe.photoHref === "string" && recipe.photoHref.startsWith("https://") ? recipe.photoHref : "";
  const credit = recipe.photoCredit
    ? `<p class="caption">Foto: ${photoHref ? `<a href="${esc(photoHref)}" target="_blank" rel="noopener noreferrer">${esc(recipe.photoCredit)}</a>` : esc(recipe.photoCredit)}${recipe.photoLicense ? `, ${esc(recipe.photoLicense)}` : ""}</p>`
    : "";
  return `<article class="page recipe">
    <p class="kicker"><span>Nr ${numberFor(recipe.id)}</span><span>${esc(recipe.category)}</span></p>
    <div class="title-row">
      <h1>${esc(recipe.title)}</h1>
      ${heartButton(recipe, true)}
    </div>
    ${recipe.summary ? `<p class="lede">${esc(recipe.summary)}</p>` : ""}
    ${recipe.credit ? `<p class="credit">Efter ${esc(recipe.credit)}</p>` : ""}
    <div class="recipe-meta">
      <span>${esc(formatTime(recipe.minutes))}</span>
      <div class="servings no-print">
        <button type="button" data-delta="-1" data-id="${esc(recipe.id)}" aria-label="Färre" ${current <= 1 ? "disabled" : ""}>−</button>
        <span data-servings-label>${esc(current)} ${esc(yieldName(current, recipe.yieldUnit))}</span>
        <button type="button" data-delta="1" data-id="${esc(recipe.id)}" aria-label="Fler" ${current >= 99 ? "disabled" : ""}>+</button>
      </div>
      <span class="print-only">${esc(current)} ${esc(yieldName(current, recipe.yieldUnit))}</span>
      ${current !== recipe.servings ? `<button type="button" class="text-btn no-print" data-reset="${esc(recipe.id)}">Återställ</button>` : ""}
    </div>
    ${photoFrame(recipe)}
    ${credit}
    ${recipe.note ? `<blockquote class="note"><p>${esc(recipe.note)}</p></blockquote>` : ""}
    <div class="recipe-layout">
      <section>
        <h2>Ingredienser</h2>
        <ul class="ingredients">${ingredients}</ul>
        ${current !== recipe.servings ? `<p class="scale-note">Mängderna är omräknade från ${esc(recipe.servings)} ${esc(yieldName(recipe.servings, recipe.yieldUnit))}.</p>` : ""}
      </section>
      <section>
        <h2>Gör så här</h2>
        <ol class="steps">${steps}</ol>
      </section>
    </div>
    <div class="toolbar no-print">
      <a class="btn-quiet" href="/redigera/${esc(recipe.id)}">Ändra</a>
      <button type="button" class="btn-quiet" data-action="print">Skriv ut</button>
      <button type="button" class="btn-quiet" data-action="copy">Kopiera länken</button>
    </div>
  </article>`;
}

function ingredientRow(ingredient = {}) {
  const units = ["", "g", "kg", "ml", "dl", "msk", "tsk", "krm", "st"];
  const unit = ingredient.unit || "";
  const known = new Set(units);
  const options = units.map((item) => `<option value="${esc(item)}"${item === unit ? " selected" : ""}>${item || "–"}</option>`).join("");
  const extra = unit && !known.has(unit) ? `<option value="${esc(unit)}" selected>${esc(unit)}</option>` : "";
  const qty = ingredient.qty == null ? "" : String(ingredient.qty).replace(".", ",");
  return `<div class="row">
    <input class="qty" inputmode="decimal" value="${esc(qty)}" aria-label="Mängd" placeholder="2">
    <select class="unit" aria-label="Enhet">${options}${extra}</select>
    <input class="item" value="${esc(ingredient.item || "")}" aria-label="Ingrediens" placeholder="vetemjöl">
    <button type="button" class="icon-btn" data-remove aria-label="Ta bort rad">×</button>
  </div>`;
}

function stepRow(text = "") {
  return `<div class="row step-row">
    <textarea class="step" rows="2" aria-label="Steg">${esc(text)}</textarea>
    <button type="button" class="icon-btn" data-remove aria-label="Ta bort steg">×</button>
  </div>`;
}

function unlockView(back) {
  return `<form class="page editor" id="unlock-form">
    <p class="kicker"><span>Låst</span></p>
    <h1>Lösenord för att ändra</h1>
    <p class="lede">Alla kan läsa recepten. För att lägga till, ändra eller ta bort behövs lösenordet.</p>
    <p id="form-error" class="form-error" hidden role="alert"></p>
    <label for="editor-password">Lösenord</label>
    <input id="editor-password" type="password" autocomplete="current-password" required autofocus>
    <div class="actions">
      <button class="btn" type="submit">Lås upp</button>
      <a class="btn-quiet" href="${esc(back)}">Avbryt</a>
    </div>
  </form>`;
}

function editView(id) {
  const recipe = id ? state.recipes.find((item) => item.id === id) : null;
  if (id && !recipe) {
    return `<div class="page"><h1>Det receptet är borta</h1><p><a href="/">Tillbaka till recepten</a></p></div>`;
  }
  if (!editorToken()) return unlockView(recipe ? `/recept/${recipe.id}` : "/");
  const categories = state.categories.map((category) => {
    const selected = (recipe ? recipe.category : "Varmrätt") === category ? " selected" : "";
    return `<option value="${esc(category)}"${selected}>${esc(category)}</option>`;
  }).join("");
  const yields = state.yieldUnits.map((unit) => {
    const selected = (recipe ? recipe.yieldUnit : "portioner") === unit ? " selected" : "";
    return `<option value="${esc(unit)}"${selected}>${esc(unit)}</option>`;
  }).join("");
  const ingredients = (recipe ? recipe.ingredients : [{}, {}, {}]).map(ingredientRow).join("");
  const steps = (recipe ? recipe.steps : ["", "", ""]).map(stepRow).join("");
  const src = recipe ? safeSrc(recipe.image) : "";
  const back = recipe ? `/recept/${recipe.id}` : "/";
  return `<form class="page editor" id="recipe-form" data-id="${esc(recipe ? recipe.id : "")}" data-image="${esc(src)}" novalidate>
    <p class="kicker"><span>${recipe ? "Ändra" : "Nytt"} recept</span></p>
    <h1>${recipe ? esc(recipe.title) : "Skriv in ett recept"}</h1>
    <p id="form-error" class="form-error" hidden role="alert"></p>
    <label for="title">Namn</label>
    <input id="title" type="text" maxlength="80" required value="${esc(recipe ? recipe.title : "")}" ${recipe ? "" : "autofocus"}>
    <div class="pair">
      <div>
        <label for="category">Kategori</label>
        <select id="category">${categories}</select>
      </div>
      <div>
        <label for="credit">Vems recept</label>
        <input id="credit" type="text" maxlength="60" value="${esc(recipe ? recipe.credit : "")}" placeholder="Mormor">
      </div>
    </div>
    <label for="summary">Kort beskrivning</label>
    <textarea id="summary" rows="2" maxlength="280">${esc(recipe ? recipe.summary : "")}</textarea>
    <div class="pair">
      <div>
        <label for="minutes">Tid i minuter</label>
        <input id="minutes" type="number" min="1" max="20000" inputmode="numeric" value="${esc(recipe ? recipe.minutes : 45)}">
        <p class="hint">Räkna med jäsning, ugn och vilotid.</p>
      </div>
      <div>
        <label for="servings">Antal</label>
        <input id="servings" type="number" min="1" max="200" inputmode="numeric" value="${esc(recipe ? recipe.servings : 4)}">
      </div>
    </div>
    <label for="yield">Räknas som</label>
    <select id="yield">${yields}</select>
    <label for="photo">Bild</label>
    <input id="photo" type="file" accept="image/jpeg,image/png,image/webp">
    <img id="preview" class="preview" alt="" ${src ? `src="${esc(src)}"` : "hidden"}>
    <p class="stack"><button type="button" class="text-btn" id="clear-image" data-clear-image ${src ? "" : "hidden"}>Ta bort bilden</button></p>
    <p class="hint">En bild från köket gör receptet lättare att känna igen. Stora bilder förminskas innan de sparas.</p>
    <label>Ingredienser</label>
    <div id="ingredients">${ingredients}</div>
    <p class="stack"><button type="button" class="text-btn" data-add="ingredient">Lägg till ingrediens</button></p>
    <label>Gör så här</label>
    <div id="steps">${steps}</div>
    <p class="stack"><button type="button" class="text-btn" data-add="step">Lägg till steg</button></p>
    <label for="note">Anteckning</label>
    <textarea id="note" rows="3" maxlength="600">${esc(recipe ? recipe.note : "")}</textarea>
    <label class="check"><input id="featured" type="checkbox" ${recipe && recipe.featured ? "checked" : ""}> Visa på första sidan</label>
    <div class="actions">
      <button class="btn" type="submit">Spara receptet</button>
      <a class="btn-quiet" href="${esc(back)}">Avbryt</a>
    </div>
    ${recipe ? `<p class="danger-zone"><button type="button" class="text-btn" data-delete="${esc(recipe.id)}">Ta bort receptet</button></p>` : ""}
  </form>`;
}

function view(route) {
  if (!state.ready) return `<div class="page"><p class="loading">Slår upp boken…</p></div>`;
  if (route.name === "home") return homeView();
  if (route.name === "recipe") return recipeView(route.id);
  if (route.name === "edit") return editView(route.id);
  return `<div class="page"><h1>Den sidan finns inte i boken</h1><p><a href="/">Tillbaka till recepten</a></p></div>`;
}

function setTitle(route) {
  if (route.name === "recipe") {
    const recipe = state.recipes.find((item) => item.id === route.id);
    document.title = recipe ? `${recipe.title} · Mormors lilla röda` : "Mormors lilla röda";
    return;
  }
  if (route.name === "edit") {
    document.title = `${route.id ? "Ändra recept" : "Nytt recept"} · Mormors lilla röda`;
    return;
  }
  document.title = "Mormors lilla röda";
}

function watchImages() {
  document.querySelectorAll("img[data-letter]").forEach((img) => {
    const fail = () => {
      const fallback = document.createElement("div");
      fallback.className = `${img.className} photo-fallback`.trim();
      fallback.setAttribute("aria-hidden", "true");
      fallback.textContent = img.dataset.letter || "";
      img.replaceWith(fallback);
    };
    img.addEventListener("error", fail);
    if (img.complete && img.naturalWidth === 0) fail();
  });
}

function render() {
  readUrl();
  const route = parseRoute();
  document.querySelector("#app").innerHTML = view(route);
  setTitle(route);
  watchImages();
}

function showError(message) {
  const error = document.querySelector("#form-error");
  if (!error) return;
  error.hidden = false;
  error.textContent = message;
}

function parseQty(value) {
  const text = value.trim().replace(",", ".");
  if (!text) return null;
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0) return Number.NaN;
  return number;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Bilden gick inte att läsa. Prova en jpg eller png."));
    reader.readAsDataURL(blob);
  });
}

async function shrinkImage(file) {
  if (!file.type.startsWith("image/")) throw new Error("Filen behöver vara en bild.");
  try {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      bitmap = await createImageBitmap(file);
    }
    const maxSide = 1600;
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
    if (!blob) throw new Error("oläsbar");
    return blobToDataUrl(blob);
  } catch {
    throw new Error("Bilden gick inte att läsa. Prova en jpg eller png.");
  }
}

async function onSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const error = document.querySelector("#form-error");
  if (error) error.hidden = true;
  const title = form.querySelector("#title").value.trim();
  if (!title) return showError("Receptet behöver ett namn.");
  const ingredients = [...form.querySelectorAll("#ingredients .row")].map((row) => ({
    qty: parseQty(row.querySelector(".qty").value),
    unit: row.querySelector(".unit").value,
    item: row.querySelector(".item").value.trim(),
  })).filter((item) => item.item);
  if (ingredients.some((item) => Number.isNaN(item.qty))) {
    return showError("En mängd ser fel ut. Använd siffror, till exempel 1,5.");
  }
  if (!ingredients.length) return showError("Lägg till minst en ingrediens.");
  const steps = [...form.querySelectorAll("#steps .step")].map((field) => field.value.trim()).filter(Boolean);
  if (!steps.length) return showError("Lägg till minst ett steg.");
  const minutes = Number(form.querySelector("#minutes").value);
  const servings = Number(form.querySelector("#servings").value);
  if (!Number.isInteger(minutes) || minutes < 1) return showError("Skriv tiden i hela minuter.");
  if (!Number.isInteger(servings) || servings < 1) return showError("Skriv hur många det räcker till.");

  const photoInput = form.querySelector("#photo");
  const payload = {
    title,
    category: form.querySelector("#category").value,
    credit: form.querySelector("#credit").value.trim(),
    summary: form.querySelector("#summary").value.trim(),
    note: form.querySelector("#note").value.trim(),
    minutes,
    servings,
    yieldUnit: form.querySelector("#yield").value,
    ingredients,
    steps,
    featured: form.querySelector("#featured").checked,
    image: photoInput.dataset.cleared === "1" ? "" : (form.dataset.image || ""),
  };
  const button = form.querySelector("[type=submit]");
  button.disabled = true;
  button.textContent = "Sparar…";
  try {
    if (photoInput.files[0]) payload.imageData = await shrinkImage(photoInput.files[0]);
    const id = form.dataset.id;
    const response = await fetch(id ? `/api/recipes/${id}` : "/api/recipes", {
      method: id ? "PUT" : "POST",
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (response.status === 401) {
      sessionStorage.removeItem(EDITOR_KEY);
      render();
      showError(data.error || "Lösenord krävs för att ändra i boken.");
      return;
    }
    if (!response.ok) throw new Error(data.error || "Det gick inte att spara.");
    await refresh();
    history.pushState({}, "", `/recept/${data.id}`);
    render();
    window.scrollTo(0, 0);
  } catch (err) {
    showError(err.message || "Det gick inte att spara.");
    button.disabled = false;
    button.textContent = "Spara receptet";
  }
}

async function deleteRecipe(id) {
  const recipe = state.recipes.find((item) => item.id === id);
  const name = recipe ? recipe.title : "receptet";
  if (!confirm(`Ta bort ${name} ur boken?`)) return;
  const response = await fetch(`/api/recipes/${id}`, { method: "DELETE", headers: authHeaders() });
  if (response.status === 401) {
    sessionStorage.removeItem(EDITOR_KEY);
    render();
    showError("Lösenord krävs för att ändra i boken.");
    return;
  }
  if (!response.ok) {
    toast("Det gick inte att ta bort receptet.");
    return;
  }
  await refresh();
  history.pushState({}, "", "/");
  render();
  window.scrollTo(0, 0);
  toast("Receptet är borta ur boken.");
}

async function refresh() {
  const response = await fetch("/api/recipes");
  if (!response.ok) throw new Error("Kunde inte läsa recepten.");
  state.recipes = await response.json();
}

let toastTimer = 0;
function toast(message) {
  const element = document.querySelector("#toast");
  element.hidden = false;
  element.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    element.hidden = true;
  }, 2600);
}

function fillShare() {
  const local = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  const share = document.querySelector("#share");
  if (local && state.addresses.length) {
    share.hidden = false;
    share.textContent = `På samma wifi: ${state.addresses.join("  ·  ")}`;
  }
}

function openPhoto(src, alt) {
  closePhoto();
  const box = document.createElement("div");
  box.className = "lightbox";
  box.innerHTML = `<button type="button" class="lightbox-close" data-close-photo>Stäng</button>
    <p class="lightbox-hint">Klicka på bilden för att zooma.</p>
    <img src="${esc(src)}" alt="${esc(alt || "Receptbild")}">`;
  document.body.appendChild(box);
  document.body.classList.add("photo-open");
  box.querySelector("[data-close-photo]").focus();
}

function closePhoto() {
  document.querySelector(".lightbox")?.remove();
  document.body.classList.remove("photo-open");
}

async function onUnlock(event) {
  event.preventDefault();
  const field = event.target.querySelector("#editor-password");
  const response = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: field.value }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.token) {
    showError(data.error || "Fel lösenord.");
    field.select();
    return;
  }
  sessionStorage.setItem(EDITOR_KEY, data.token);
  render();
}

function bind() {
  document.addEventListener("click", (event) => {
    const photoZoom = event.target.closest(".lightbox img");
    if (photoZoom) {
      photoZoom.classList.toggle("is-zoomed");
      photoZoom.closest(".lightbox").classList.toggle("is-zoomed", photoZoom.classList.contains("is-zoomed"));
      return;
    }
    if (event.target.classList.contains("lightbox") || event.target.closest("[data-close-photo]")) {
      closePhoto();
      return;
    }
    if (!state.ready) return;
    const zoom = event.target.closest("[data-zoom]");
    if (zoom) {
      const img = zoom.querySelector("img");
      if (img?.src) openPhoto(img.getAttribute("src"), img.alt);
      return;
    }
    const favorite = event.target.closest("[data-fav]");
    if (favorite) {
      event.preventDefault();
      toggleFavorite(favorite.dataset.fav);
      render();
      return;
    }
    const delta = event.target.closest("[data-delta]");
    if (delta && !delta.disabled) {
      const recipe = state.recipes.find((item) => item.id === delta.dataset.id);
      if (!recipe) return;
      const current = state.servings[recipe.id] ?? recipe.servings;
      state.servings[recipe.id] = Math.min(99, Math.max(1, current + Number(delta.dataset.delta)));
      render();
      return;
    }
    const reset = event.target.closest("[data-reset]");
    if (reset) {
      delete state.servings[reset.dataset.reset];
      render();
      return;
    }
    const action = event.target.closest("[data-action]");
    if (action) {
      if (action.dataset.action === "print") window.print();
      if (action.dataset.action === "copy") {
        navigator.clipboard.writeText(location.href).then(
          () => toast("Länken är kopierad."),
          () => toast(location.href),
        );
      }
      return;
    }
    const remove = event.target.closest("[data-delete]");
    if (remove) {
      deleteRecipe(remove.dataset.delete);
      return;
    }
    const add = event.target.closest("[data-add]");
    if (add) {
      const target = document.querySelector(add.dataset.add === "step" ? "#steps" : "#ingredients");
      target.insertAdjacentHTML("beforeend", add.dataset.add === "step" ? stepRow() : ingredientRow());
      return;
    }
    const rowRemove = event.target.closest("[data-remove]");
    if (rowRemove) {
      rowRemove.closest(".row").remove();
      return;
    }
    const clearImage = event.target.closest("[data-clear-image]");
    if (clearImage) {
      const input = document.querySelector("#photo");
      input.value = "";
      input.dataset.cleared = "1";
      const preview = document.querySelector("#preview");
      preview.hidden = true;
      preview.removeAttribute("src");
      clearImage.hidden = true;
      return;
    }
    const chip = event.target.closest("[data-cat]");
    if (chip) {
      state.category = chip.dataset.cat;
      const url = listUrl();
      if (location.pathname !== "/") history.pushState({}, "", url);
      else history.replaceState({}, "", url);
      render();
      return;
    }
    const link = event.target.closest("a");
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    const url = new URL(link.href, location.origin);
    if (url.origin !== location.origin) return;
    event.preventDefault();
    const next = url.pathname + url.search;
    if (next === location.pathname + location.search) {
      window.scrollTo(0, 0);
      return;
    }
    history.pushState({}, "", next);
    render();
    window.scrollTo(0, 0);
  });

  document.addEventListener("submit", (event) => {
    if (event.target.id === "search-form") event.preventDefault();
    if (event.target.id === "unlock-form") onUnlock(event);
    if (event.target.id === "recipe-form") onSubmit(event);
  });

  document.addEventListener("change", (event) => {
    if (event.target.id !== "photo" || !event.target.files[0]) return;
    const preview = document.querySelector("#preview");
    preview.src = URL.createObjectURL(event.target.files[0]);
    preview.hidden = false;
    event.target.dataset.cleared = "";
    const clear = document.querySelector("#clear-image");
    if (clear) clear.hidden = false;
  });

  document.querySelector("#q").addEventListener("input", (event) => {
    if (!state.ready) return;
    state.query = event.target.value;
    const url = listUrl();
    if (location.pathname !== "/") history.pushState({}, "", url);
    else history.replaceState({}, "", url);
    render();
  });

  document.querySelector("#search-form").addEventListener("submit", (event) => event.preventDefault());

  window.addEventListener("popstate", () => {
    document.querySelector("#q").blur();
    render();
  });

  document.addEventListener("keydown", (event) => {
    const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName);
    if (event.key === "Escape" && document.querySelector(".lightbox")) {
      closePhoto();
      return;
    }
    if (event.key === "/" && !typing) {
      event.preventDefault();
      document.querySelector("#q").focus();
    }
  });
}

async function init() {
  try {
    const [recipesResponse, infoResponse] = await Promise.all([
      fetch("/api/recipes"),
      fetch("/api/info"),
    ]);
    if (!recipesResponse.ok) throw new Error("saknas");
    state.recipes = await recipesResponse.json();
    if (infoResponse.ok) {
      const info = await infoResponse.json();
      if (Array.isArray(info.categories)) state.categories = info.categories;
      if (Array.isArray(info.yieldUnits)) state.yieldUnits = info.yieldUnits;
      state.addresses = info.addresses || [];
    }
    fillShare();
  } catch {
    state.loadError = "Kokboken svarar inte. Starta den med python3 server.py och ladda om sidan.";
  }
  state.ready = true;
  render();
}

bind();
init();
