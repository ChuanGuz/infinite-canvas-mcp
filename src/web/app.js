const $ = (selector) => document.querySelector(selector);
const categories = {
  convention_practice: ["规定做法与约定", "#a65e2e"],
  architecture_design: ["架构与模型设计", "#2f6c78"],
  feature_impl: ["功能实现", "#2f6b55"],
  pitfall_fix: ["踩坑与问题修复", "#b84a39"],
  best_practice: ["最终确定的好用法", "#9e6b1e"],
};
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const options = () =>
  Object.entries(categories)
    .map(([key, [label]]) => `<option value="${key}">${label}</option>`)
    .join("");
const bullets = (values) =>
  values.length
    ? `<ul>${values.map((value) => `<li>${escape(value)}</li>`).join("")}</ul>`
    : '<p class="muted">暂无记录</p>';
const boundsStyle = (b) =>
  `left:${b.x}px;top:${b.y}px;width:${b.width}px;height:${b.height}px;`;
let store,
  groupFilter = "",
  view = { x: 24, y: 24, zoom: 0.5 },
  viewCanvasId;
let drawerMode = "",
  selectedNode,
  handoff,
  config,
  modalAction,
  modalCanvasId,
  pending = false;
let snapshotEpoch = 0,
  handoffRequest = 0,
  noticeTimer,
  searchTimer,
  experienceRequest = 0;
const viewport = $("#viewport");
function toggleNavigation(
  open = !document.body.classList.contains("sidebar-open"),
) {
  document.body.classList.toggle("sidebar-open", open);
  const toggle = $("[aria-controls='sidebar']");
  toggle.setAttribute("aria-expanded", String(open));
  if (matchMedia("(max-width: 720px)").matches) {
    $("main").inert = open;
    (open ? $("#sidebar button") : toggle).focus();
  }
}
matchMedia("(max-width: 720px)").addEventListener("change", () => {
  $("main").inert = false;
  document.body.classList.remove("sidebar-open");
  $("[aria-controls='sidebar']").setAttribute("aria-expanded", "false");
});
document.addEventListener("keydown", (event) => {
  if (
    event.key === "Escape" &&
    !$("#modal").open &&
    !$("#drawer").open &&
    document.body.classList.contains("sidebar-open")
  )
    toggleNavigation(false);
});
const activeCanvas = () =>
  store?.canvases.find((canvas) => canvas.id === store.activeCanvasId);
const writable = (canvas) =>
  canvas?.status === "active" &&
  canvas.stages.find((s) => s.stageNumber === canvas.currentStageNumber)
    ?.status === "in_progress";

async function api(path, input) {
  const response = await fetch(
    `/api/${path}`,
    input === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error?.message ?? `请求失败 (${response.status})`);
  return result;
}
function notify(message) {
  clearTimeout(noticeTimer);
  $("#notice").textContent = message;
  $("#notice").hidden = false;
  noticeTimer = setTimeout(() => {
    $("#notice").hidden = true;
  }, 6000);
}
async function refresh() {
  const epoch = snapshotEpoch;
  const snapshot = await api("state");
  if (epoch === snapshotEpoch) acceptSnapshot(snapshot);
}
function acceptSnapshot(snapshot) {
  snapshotEpoch++;
  store = snapshot;
  const canvas = activeCanvas();
  if (viewCanvasId !== canvas?.id) {
    viewCanvasId = canvas?.id;
    groupFilter =
      groupFilter && canvas && canvas.groupId !== groupFilter
        ? ""
        : groupFilter;
    let saved;
    try {
      saved = JSON.parse(localStorage.getItem(`canvas-view:${viewCanvasId}`));
    } catch {
      /* Storage may be unavailable. */
    }
    if (
      saved &&
      [saved.x, saved.y, saved.zoom].every(Number.isFinite) &&
      saved.zoom >= 0.03 &&
      saved.zoom <= 2
    )
      view = saved;
    else if (canvas)
      fitBounds(
        canvas.stages.find((s) => s.stageNumber === canvas.currentStageNumber)
          .bounds,
      );
  }
  renderNavigation();
  renderCanvas();
  void renderExperiences();
  if (drawerMode === "handoff") void renderHandoff();
  else if (drawerMode === "node") renderNodeDetails();
}
function renderNavigation() {
  $("#groups").innerHTML =
    `<button class="nav-item ${!groupFilter ? "active" : ""}" data-group="" aria-pressed="${!groupFilter}"><span class="dot"></span><span class="nav-copy">全部画布</span><span>${store.canvases.length}</span></button>` +
    store.groups
      .map(
        (group) =>
          `<button class="nav-item ${groupFilter === group.id ? "active" : ""}" data-group="${group.id}" aria-pressed="${groupFilter === group.id}"><span class="dot" data-color="${escape(group.color)}"></span><span class="nav-copy">${escape(group.name)}</span><span>${store.canvases.filter((c) => c.groupId === group.id).length}</span></button>`,
      )
      .join("");
  for (const dot of document.querySelectorAll("[data-color]"))
    if (CSS.supports("color", dot.dataset.color))
      dot.style.backgroundColor = dot.dataset.color;
  const canvases = store.canvases.filter(
    (c) => !groupFilter || c.groupId === groupFilter,
  );
  $("#canvases").innerHTML =
    canvases
      .map(
        (c) =>
          `<button class="nav-item ${c.id === store.activeCanvasId ? "active" : ""}" data-canvas="${c.id}" aria-pressed="${c.id === store.activeCanvasId}"><span class="nav-copy">${escape(c.title)}<small><span class="badge">阶段 ${c.currentStageNumber}</span> ${canvasStatus(c)}</small></span><span>↗</span></button>`,
      )
      .join("") || '<p class="muted">此分组还没有画布。</p>';
}
function canvasStatus(canvas) {
  return canvas.status === "active"
    ? "进行中"
    : canvas.status === "completed"
      ? "已结项"
      : "已归档";
}
function renderCanvas() {
  const canvas = activeCanvas();
  $("#empty-state").hidden = Boolean(canvas);
  $("#project-title").textContent = canvas?.title ?? "无限画布工作台";
  $("#project-group").textContent = canvas
    ? `${store.groups.find((g) => g.id === canvas.groupId)?.name} / 项目工作台`
    : "项目工作台";
  $("#project-status").textContent = canvas
    ? `阶段 ${canvas.currentStageNumber} · ${canvasStatus(canvas)}`
    : "尚未创建画布";
  $("#canvas-description").textContent =
    canvas?.description || "从学习记录，到可复用的好用法。";
  $("#canvas-stats").textContent = canvas
    ? `${canvas.stages.length} 个阶段 / ${canvas.nodes.length} 张知识卡片 / ${canvas.edges.length} 条演进连线`
    : "";
  for (const action of ["record", "consolidate", "advance", "finalize"]) {
    const enabled = ["record", "consolidate"].includes(action)
      ? writable(canvas)
      : canvas?.status === "active";
    $(`[data-action="${action}"]`).disabled = !enabled || pending;
  }
  $("#stage-jumps").innerHTML = canvas
    ? canvas.stages
        .map(
          (s) =>
            `<button data-stage="${s.id}" class="${s.stageNumber === canvas.currentStageNumber ? "current" : ""}">阶段 ${s.stageNumber} ${s.status === "consolidated" ? "✓" : "·"}</button>`,
        )
        .join("") +
      (canvas.finalZone
        ? `<button class="final-jump" data-stage="${canvas.finalZone.id}">✧ 终局精华区</button>`
        : "")
    : "";
  if (!canvas) {
    $("#world").replaceChildren();
    return;
  }
  const focusedId = document.activeElement?.dataset.node;
  const zones = canvas.stages
    .map(
      (s) =>
        `<section class="zone ${s.stageNumber === canvas.currentStageNumber ? "current" : ""}" data-zone="${s.id}" style="${boundsStyle(s.bounds)}"><header><h2>阶段 ${s.stageNumber} <span> / ${escape(s.title)}</span></h2><span class="badge">${s.status === "consolidated" ? "已整理归档" : "进行中"}</span><p class="zone-summary">${escape(s.summary || "记录、探索、验证，让知识在这里积累。")}</p></header></section>` +
        Object.entries(categories)
          .map(([category, [label, color]]) => {
            const cluster = s.clusters[category];
            return `<section class="cluster" data-cluster="${cluster.id}" style="${boundsStyle(cluster.bounds)}--category:${color}"><h3>${label}<small>${cluster.nodeIds.length} 张卡片</small></h3>${cluster.nodeIds.length ? "" : '<small class="cluster-empty">等待这个阶段的第一条记录</small>'}</section>`;
          })
          .join(""),
    )
    .join("");
  const final = canvas.finalZone;
  const patterns = final
    ? store.crossProjectExperiences.filter((e) =>
        final.reusablePatterns.includes(e.id),
      )
    : [];
  const finalHTML = final
    ? `<section class="zone final" data-zone="${final.id}" style="${boundsStyle(final.bounds)}"><header><h2>✧ 项目结尾总整理 / 终局精华区</h2><span class="badge">已结项 · ${patterns.length} 个可复用模式</span><p class="zone-summary">${escape(final.handoffSummary)}</p></header></section><section class="final-patterns" style="${boundsStyle(patternBounds(final, patterns))}"><h3>跨项目可复用模式 · ${patterns.length}</h3>${patterns.map((e) => `<div class="pattern"><strong>${escape(e.title)}</strong><p>${escape(e.content)}</p></div>`).join("") || "<p>暂无已验证的可复用模式。</p>"}</section>`
    : "";
  const nodes = canvas.nodes
    .map(
      (n) =>
        `<button class="node ${n.kind}" data-node="${n.id}" aria-label="查看：${escape(n.title)}" style="${boundsStyle(n.bounds)}--category:${categories[n.category][1]}"><span class="category-badge">${categories[n.category][0]} · ${n.kind === "stage_summary" ? "阶段小结" : n.validated ? "已验证" : n.status === "open" ? "待解决" : "待验证"}</span><h3>${escape(n.title)}</h3>${bullets(n.summaryBullets.slice(0, 2).map(text => text.length > 56 ? text.slice(0, 55) + "…" : text))}</button>`,
    )
    .join("");
  $("#world").innerHTML = zones + finalHTML + renderEdges(canvas) + nodes;
  if (focusedId)
    $(`[data-node="${focusedId}"]`)?.focus({ preventScroll: true });
  transform();
}
function patternBounds(final, patterns) {
  return {
    x: final.bounds.x,
    y: final.bounds.y + final.bounds.height + 24,
    width: final.bounds.width,
    height: Math.min(900, 100 + patterns.length * 130),
  };
}
function renderEdges(canvas) {
  const entities = new Map(
    [
      ...canvas.nodes,
      ...canvas.stages,
      ...canvas.stages.flatMap((s) => Object.values(s.clusters)),
    ].map((entity) => [entity.id, entity.bounds]),
  );
  return `<svg class="edges" width="1" height="1" aria-label="知识演进连线"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#8fbfa8"/></marker></defs>${canvas.edges
    .map((edge) => {
      const a = entities.get(edge.source),
        b = entities.get(edge.target);
      if (!a || !b) return "";
      const forward = b.x >= a.x;
      const x1 = a.x + (forward ? a.width : 0),
        y1 = a.y + a.height / 2;
      const x2 = b.x + (forward ? 0 : b.width),
        y2 = b.y + b.height / 2;
      const bend = Math.max(55, Math.abs(x2 - x1) / 2) * (forward ? 1 : -1);
      return `<path class="edge ${edge.type}" data-edge="${edge.id}" d="M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}" marker-end="url(#arrow)"><title>${escape(edge.label || edge.type)}</title></path>`;
    })
    .join("")}</svg>`;
}
async function renderExperiences() {
  const request = ++experienceRequest;
  const params = new URLSearchParams({
    query: $("#experience-search").value,
    limit: "1000",
  });
  if ($("#experience-category").value)
    params.set("category", $("#experience-category").value);
  try {
    const experiences = await api(`experiences?${params}`);
    if (request !== experienceRequest) return;
    const canvas = activeCanvas();
    $("#experience-count").textContent = experiences.length;
    $("#experiences").innerHTML =
      experiences
        .map((e) => {
          const applied = canvas?.nodes.some(
            (n) => n.sourceExperienceId === e.id,
          );
          const own = e.sourceCanvasId === canvas?.id;
          return `<article class="experience-card"><small>${categories[e.category][0]}</small><h3>${escape(e.title)}</h3><p>${escape(e.content)}</p><small>来自 ${escape(store.canvases.find((c) => c.id === e.sourceCanvasId)?.title ?? "历史项目")}</small><button data-experience="${e.id}" ${!writable(canvas) || applied || own || pending ? "disabled" : ""}>${applied ? "✓ 已应用到当前画布" : own ? "来自当前画布" : "应用到当前画布 ↗"}</button></article>`;
        })
        .join("") ||
      '<p class="muted" style="margin-top:14px">暂无匹配经验。项目结尾总整理后，已验证的做法会出现在这里。</p>';
  } catch (error) {
    if (request === experienceRequest)
      $("#experiences").textContent = `经验库加载失败：${error.message}`;
  }
}
function transform() {
  $("#world").style.transform =
    `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
  $("#zoom-level").textContent = `${Math.round(view.zoom * 100)}%`;
  viewport.style.backgroundPosition = `${view.x}px ${view.y}px`;
  viewport.style.backgroundSize = `${24 * view.zoom}px ${24 * view.zoom}px`;
  if (viewCanvasId)
    try {
      localStorage.setItem(`canvas-view:${viewCanvasId}`, JSON.stringify(view));
    } catch {
      /* Navigation still works without storage. */
    }
}
function fitBounds(b) {
  const zoom = Math.max(
    0.03,
    Math.min(
      1,
      (viewport.clientWidth - 56) / b.width,
      (viewport.clientHeight - 56) / b.height,
    ),
  );
  view = {
    zoom,
    x: (viewport.clientWidth - b.width * zoom) / 2 - b.x * zoom,
    y: (viewport.clientHeight - b.height * zoom) / 2 - b.y * zoom,
  };
  transform();
}
function fitAll() {
  const canvas = activeCanvas();
  if (!canvas) return;
  const bounds = canvas.stages.map((s) => s.bounds);
  if (canvas.finalZone)
    bounds.push(
      canvas.finalZone.bounds,
      patternBounds(
        canvas.finalZone,
        store.crossProjectExperiences.filter((e) =>
          canvas.finalZone.reusablePatterns.includes(e.id),
        ),
      ),
    );
  const x = Math.min(...bounds.map((b) => b.x)),
    y = Math.min(...bounds.map((b) => b.y));
  fitBounds({
    x,
    y,
    width: Math.max(...bounds.map((b) => b.x + b.width)) - x,
    height: Math.max(...bounds.map((b) => b.y + b.height)) - y,
  });
}
function zoomAt(
  factor,
  x = viewport.clientWidth / 2,
  y = viewport.clientHeight / 2,
) {
  const zoom = Math.max(0.03, Math.min(2, view.zoom * factor));
  view.x = x - ((x - view.x) * zoom) / view.zoom;
  view.y = y - ((y - view.y) * zoom) / view.zoom;
  view.zoom = zoom;
  transform();
}
let drag;
viewport.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || event.target.closest("button")) return;
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
  viewport.setPointerCapture(event.pointerId);
  viewport.classList.add("dragging");
  viewport.focus({ preventScroll: true });
});
viewport.addEventListener("pointermove", (event) => {
  if (!drag || drag.id !== event.pointerId) return;
  view.x += event.clientX - drag.x;
  view.y += event.clientY - drag.y;
  drag.x = event.clientX;
  drag.y = event.clientY;
  transform();
});
for (const name of ["pointerup", "pointercancel", "lostpointercapture"])
  viewport.addEventListener(name, () => {
    drag = null;
    viewport.classList.remove("dragging");
  });
viewport.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const delta =
      event.deltaY *
      (event.deltaMode === 1
        ? 16
        : event.deltaMode === 2
          ? viewport.clientHeight
          : 1);
    zoomAt(
      Math.exp(-Math.max(-600, Math.min(600, delta)) * 0.0015),
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
  },
  { passive: false },
);
viewport.addEventListener("keydown", (event) => {
  if (event.target !== viewport) return;
  const moves = {
    ArrowLeft: [60, 0],
    ArrowRight: [-60, 0],
    ArrowUp: [0, 60],
    ArrowDown: [0, -60],
  };
  if (moves[event.key]) {
    event.preventDefault();
    view.x += moves[event.key][0];
    view.y += moves[event.key][1];
    transform();
  } else if (event.key.toLowerCase() === "f") fitAll();
  else if (["+", "="].includes(event.key)) zoomAt(1.2);
  else if (event.key === "-") zoomAt(1 / 1.2);
});
// Keyboard focus on an offscreen card brings it into view without scrolling the world element.
viewport.addEventListener("focusin", (event) => {
  const node = activeCanvas()?.nodes.find(
    (n) => n.id === event.target.dataset.node,
  );
  if (!node) return;
  const b = node.bounds;
  if (
    b.x * view.zoom + view.x < 0 ||
    (b.x + b.width) * view.zoom + view.x > viewport.clientWidth ||
    b.y * view.zoom + view.y < 0 ||
    (b.y + b.height) * view.zoom + view.y > viewport.clientHeight
  )
    fitBounds(b);
});

function field(name, label, type = "text", extra = "") {
  return `<label for="field-${name}">${label}</label><input id="field-${name}" name="${name}" type="${type}" ${extra}>`;
}
function textArea(name, label, required = false) {
  return `<label for="field-${name}">${label}</label><textarea id="field-${name}" name="${name}" ${required ? "required" : ""}></textarea>`;
}
function openForm(action) {
  if (!store || pending) return;
  if (action === "canvas" && !store.groups.length) {
    notify("请先创建一个画布分组。");
    action = "group";
  }
  modalAction = action;
  modalCanvasId = activeCanvas()?.id;
  const titles = {
    group: "新建画布分组",
    canvas: "新建画布",
    record: "记录学习 / 功能 / 约定",
    consolidate: "阶段分类整理",
    advance: "开启下一阶段",
    finalize: "项目结尾总整理",
  };
  $("#modal-title").textContent = titles[action];
  $("#modal-context").textContent = ["group", "canvas"].includes(action)
    ? "让每一份项目知识都有自己的归属。"
    : `当前目标：${activeCanvas()?.title} · 阶段 ${activeCanvas()?.currentStageNumber}`;
  let fields = "";
  if (action === "group")
    fields =
      field("name", "分组名称", "text", "required") +
      field("color", "分组颜色", "color", 'value="#2f6b55"') +
      textArea("description", "说明");
  if (action === "canvas")
    fields =
      field("title", "画布名称", "text", "required") +
      field(
        "projectKey",
        "项目唯一标识",
        "text",
        'required placeholder="例如 发布服务"',
      ) +
      `<label for="field-groupId">所属分组</label><select id="field-groupId" name="groupId">${store.groups.map((g) => `<option value="${g.id}" ${g.id === groupFilter ? "selected" : ""}>${escape(g.name)}</option>`).join("")}</select>` +
      textArea("description", "项目说明") +
      field("stageTitle", "第一阶段名称", "text", 'placeholder="项目基础"');
  if (action === "record")
    fields =
      field("title", "标题", "text", 'required maxlength="300"') +
      textArea("content", "内容 / 学习记录", true) +
      `<label for="field-category">分类</label><select id="field-category" name="category"><option value="">自动分类</option>${options()}</select>` +
      field("tags", "标签（逗号分隔）") +
      field("relatedFiles", "相关文件（逗号分隔）") +
      field(
        "importance",
        "重要程度（1–5）",
        "number",
        'min="1" max="5" value="3" required',
      ) +
      '<label for="field-status">记录状态</label><select id="field-status" name="status"><option value="active">有效记录</option><option value="open">待解决</option><option value="superseded">已被替代</option></select><label class="check"><input type="checkbox" name="validated"> 已经过实践验证，可参与项目结尾总整理</label>';
  if (action === "consolidate")
    fields =
      '<p class="muted">按五大分类生成阶段小结并归档。归档后，需开启下一阶段才能继续记录。</p><label class="check"><input type="checkbox" name="advanceToNextStage"> 整理后自动开启下一阶段</label>' +
      field("nextStageTitle", "下一阶段名称（可选）");
  if (action === "advance")
    fields =
      '<p class="muted">当前阶段将自动整理归档，随后创建新的阶段区域。</p>' +
      field("title", "下一阶段名称（可选）");
  if (action === "finalize") {
    const candidates = activeCanvas().nodes.filter(
      (n) =>
        ["learning", "imported"].includes(n.kind) &&
        n.status === "active" &&
        !n.validated,
    );
    fields =
      '<p class="muted">结项后画布将只读。已验证的约定与好用法，以及重要程度 ≥ 4 的架构、实现和修复，将发布到跨项目经验库。</p>' +
      textArea("summary", "项目交接总结（可选）") +
      '<h3>确认已验证的记录</h3><p class="muted">仅勾选你已实际验证的内容。未勾选记录仍保留在交接文档中。</p><div class="review-list">' +
      candidates
        .map(
          (n) =>
            `<label class="check"><input type="checkbox" name="validatedNodeIds" value="${n.id}"><span>${escape(n.title)} <small>· ${categories[n.category][0]} · 重要程度 ${n.importance}</small></span></label>`,
        )
        .join("") +
      (candidates.length ? "" : '<p class="muted">没有待确认的有效记录。</p>') +
      "</div>";
  }
  $("#form-fields").innerHTML = fields;
  $("#form-error").textContent = "";
  $("#form-submit").textContent =
    action === "finalize" ? "确认结项并生成精华" : "保存";
  $("#modal").showModal();
}
$("#action-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (pending) return;
  const data = new FormData(event.currentTarget);
  const input = Object.fromEntries(data);
  const action = modalAction;
  for (const key of Object.keys(input))
    if (typeof input[key] === "string") input[key] = input[key].trim();
  if (action === "canvas" && !input.stageTitle) delete input.stageTitle;
  if (action === "record") {
    for (const key of ["tags", "relatedFiles"])
      input[key] = input[key]
        .split(/[,，\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
    input.importance = Number(input.importance);
    input.validated = data.has("validated");
    if (!input.category) delete input.category;
  }
  if (action === "consolidate") {
    input.advanceToNextStage = data.has("advanceToNextStage");
    if (!input.nextStageTitle) delete input.nextStageTitle;
  }
  if (action === "advance" && !input.title) delete input.title;
  if (action === "finalize") {
    input.validatedNodeIds = data.getAll("validatedNodeIds");
    if (!input.summary) delete input.summary;
  }
  const routes = {
    group: "groups",
    canvas: "canvases",
    record: "learnings",
    consolidate: "stages/consolidate",
    advance: "stages/advance",
    finalize: "distill",
  };
  const route = ["group", "canvas"].includes(action)
    ? routes[action]
    : `canvases/${modalCanvasId}/${routes[action]}`;
  pending = true;
  $("#form-submit").disabled = true;
  $("#form-error").textContent = "";
  try {
    const result = await api(route, input);
    $("#modal").close();
    await refresh();
    if (action === "group") {
      groupFilter = result.id;
      renderNavigation();
    }
    if (
      action === "advance" ||
      (action === "consolidate" && input.advanceToNextStage)
    ) {
      const canvas = activeCanvas();
      if (canvas?.id === modalCanvasId)
        fitBounds(
          canvas.stages.find((s) => s.stageNumber === canvas.currentStageNumber)
            .bounds,
        );
    }
    if (action === "finalize" && activeCanvas()?.id === modalCanvasId)
      fitBounds(activeCanvas().finalZone.bounds);
    notify(
      action === "record"
        ? `已记录到「${categories[result.category][0]}」`
        : "已保存并同步到画布与交接文档。",
    );
  } catch (error) {
    $("#form-error").textContent = error.message;
    if (!$("#modal").open) notify(error.message);
  } finally {
    pending = false;
    $("#form-submit").disabled = false;
    if (store) {
      renderCanvas();
      void renderExperiences();
    }
  }
});

async function renderHandoff() {
  const request = ++handoffRequest;
  const canvas = activeCanvas();
  handoff = null;
  $("#drawer-title").textContent = "中文项目交接与助手接入";
  $("#drawer-content").innerHTML = '<p class="muted">正在读取最新交接文档…</p>';
  try {
    const [context, bundle] = await Promise.all([
      canvas ? api('canvases/' + canvas.id + '/handoff') : null,
      api('mcp/connect-bundle' + (canvas ? '?canvasId=' + encodeURIComponent(canvas.id) : '')),
    ]);
    if (request !== handoffRequest || drawerMode !== "handoff") return;
    handoff = context;
    config = bundle;
    $("#drawer-content").innerHTML =
      '<div class="provider-cards-grid">' + Object.values(bundle.providers).map(provider =>
        '<article class="provider-card"><div class="provider-card-header"><strong>' + escape(provider.label) +
        '</strong></div><p>' + escape(provider.description) + '</p><div class="provider-card-actions">' +
        '<button data-action="copy-provider" data-provider="' + provider.id + '">📋 一键复制发给 ' + escape(provider.label) + '</button>' +
        '<button data-action="configure-provider" data-provider="' + provider.id + '">⚡ 一键自动写入本机 ' + escape(provider.label) + ' 配置</button>' +
        '</div><details><summary>查看连接配置</summary><pre>' + escape(provider.configSnippet) + '</pre></details></article>'
      ).join('') + '</div>' +
      (context ? '<section><div class="copy-row"><h3>HANDOFF.md · 完整中文交接文档</h3><button data-copy="handoff">复制交接文档</button></div><pre id="handoff-markdown">' +
        escape(context.markdown) + '</pre></section>' : '<p>创建画布后，这里会显示完整中文交接文档。</p>');
  } catch (error) {
    if (request === handoffRequest && drawerMode === "handoff")
      $("#drawer-content").textContent = '交接加载失败：' + error.message;
  }
}

async function connectProvider(button, action) {
  const providerId = button.dataset.provider;
  const canvasId = activeCanvas()?.id;
  button.disabled = true;
  try {
    const bundle = await api('mcp/connect-bundle' + (canvasId ? '?canvasId=' + encodeURIComponent(canvasId) : ''));
    const provider = bundle.providers[providerId];
    if (!provider) throw new Error('未找到所选助手的连接配置。');
    let result;
    if (action !== 'copy-provider')
      result = await api('mcp/quick-connect', { provider: providerId, ...(canvasId ? { canvasId } : {}) });
    if (action !== 'configure-provider') {
      try { await copyText(provider.aiPrompt); }
      catch {
        drawerMode = 'copy-fallback';
        $("#drawer-title").textContent = '请手动复制连接与交接指令';
        $("#drawer-content").innerHTML = '<p>浏览器未允许自动复制。请选择下方完整指令复制。</p><textarea aria-label="连接与交接指令" readonly></textarea>';
        $("#drawer-content textarea").value = provider.aiPrompt;
        if (!$("#drawer").open) $("#drawer").showModal();
        $("#drawer-content textarea").select();
        notify('自动复制未成功，请在详情中手动复制。');
        return;
      }
      notify(action === 'quick-ai'
        ? '已一键配置并复制【' + provider.label + '】连接与交接指令！直接粘贴发给 ' + provider.label + ' 即可连接并继续项目。'
        : '已复制【' + provider.label + '】连接与交接指令，可直接粘贴发送。');
    } else notify(result.message);
  } finally { button.disabled = false; }
}
function renderNodeDetails() {
  const node = activeCanvas()?.nodes.find((n) => n.id === selectedNode);
  $("#drawer-title").textContent = node?.title ?? "记录已不在当前画布";
  if (!node) {
    $("#drawer-content").textContent = "请关闭详情，选择当前画布中的卡片。";
    return;
  }
  $("#drawer-content").innerHTML =
    `<p><span class="badge">${categories[node.category][0]}</span> ${node.zone === "final" ? "终局精华区" : `阶段 ${node.stageNumber}`} · ${node.validated ? "已验证" : "待验证"} · ${({ active: '有效记录', open: '待解决', superseded: '已替代' })[node.status]}</p><h3>完整记录</h3><p class="detail-content">${escape(node.content)}</p><h3>摘要</h3>${bullets(node.summaryBullets)}<h3>标签</h3>${bullets(node.tags)}<h3>相关文件</h3>${bullets(node.relatedFiles)}<h3>可复用做法</h3>${bullets(node.reusablePatterns)}<h3>来源与证据</h3>${bullets(node.sourceNodeIds.map((id) => activeCanvas().nodes.find((n) => n.id === id)?.title ?? id))}${node.sourceExperienceId ? `<p>来源经验：${escape(node.sourceExperienceId)}</p>` : ""}<p class="muted">重要程度 ${node.importance}/5 · ${({ learning: '学习记录', imported: '引入经验', stage_summary: '阶段小结', distillation: '终局精华' })[node.kind]}<br>更新于 ${escape(node.updatedAt)}</p>`;
}
async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); notify("已复制到剪贴板。"); return; }
    catch { /* Fall back when the browser blocks asynchronous clipboard access. */ }
  }
  const area = document.createElement("textarea");
  area.value = text;
  const previous = document.activeElement;
  ($("#drawer").open ? $("#drawer") : document.body).append(area);
  area.select();
  const success = document.execCommand("copy");
  area.remove();
  previous?.focus({ preventScroll: true });
  if (!success) throw new Error("复制失败，请手动选择并复制文档。");
  notify("已复制到剪贴板。");
}
document.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button || button.disabled) return;
  const data = button.dataset;
  try {
    if (["quick-ai", "copy-provider", "configure-provider"].includes(data.action)) await connectProvider(button, data.action);
    else if (data.action === "navigation") toggleNavigation();
    else if ("group" in data) {
      groupFilter = data.group;
      renderNavigation();
    } else if (data.canvas) {
      await api(`canvases/${data.canvas}/switch`, {});
      await refresh();
    } else if (data.stage) {
      const canvas = activeCanvas();
      const zone = [...canvas.stages, canvas.finalZone].find(
        (s) => s?.id === data.stage,
      );
      if (zone) fitBounds(zone.bounds);
    } else if (data.node) {
      selectedNode = data.node;
      drawerMode = "node";
      renderNodeDetails();
      $("#drawer").showModal();
    } else if (data.experience && !pending) {
      const canvasId = activeCanvas()?.id;
      if (!canvasId) return;
      pending = true;
      button.disabled = true;
      try {
        await api(`canvases/${canvasId}/experiences/apply`, {
          experienceId: data.experience,
        });
        await refresh();
        notify("经验已应用；请在新项目中重新验证。");
      } finally {
        pending = false;
        renderCanvas();
        void renderExperiences();
      }
    } else if (data.copy)
      await copyText(
        handoff.markdown,
      );
    else if (data.action === "close-modal") {
      if (!pending) $("#modal").close();
    } else if (data.action === "close-drawer") $("#drawer").close();
    else if (data.action === "handoff") {
      drawerMode = "handoff";
      void renderHandoff();
      $("#drawer").showModal();
    } else if (data.action === "zoom-in") zoomAt(1.2);
    else if (data.action === "zoom-out") zoomAt(1 / 1.2);
    else if (data.action === "fit") fitAll();
    else if (
      [
        "group",
        "canvas",
        "record",
        "consolidate",
        "advance",
        "finalize",
      ].includes(data.action)
    )
      openForm(data.action);
  } catch (error) {
    notify(error.message);
  }
});
$("#modal").addEventListener("cancel", (event) => {
  if (pending) event.preventDefault();
});
$("#drawer").addEventListener("close", () => {
  drawerMode = "";
  handoffRequest++;
});
$("#experience-category").insertAdjacentHTML("beforeend", options());
$("#experience-category").addEventListener(
  "change",
  () => void renderExperiences(),
);
$("#experience-search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void renderExperiences(), 180);
});
// Establish SSE after bootstrap so a slow initial GET cannot overwrite a newer event.
try {
  await refresh();
} catch (error) {
  notify(`加载失败：${error.message}。实时同步将自动重试。`);
}
let events;
function disconnected() {
  $("#sync-status").textContent = "同步中断 · 正在自动重连";
  $("#sync-status").classList.remove("connected");
}
function connectEvents() {
  events?.close();
  events = new EventSource("/api/events");
  events.onopen = () => {
    $("#sync-status").textContent = "MCP 实时同步已连接";
    $("#sync-status").classList.add("connected");
  };
  events.onerror = disconnected;
  events.addEventListener("canvas-update", (event) => {
    try {
      acceptSnapshot(JSON.parse(event.data));
    } catch (error) {
      notify(`同步数据读取失败：${error.message}`);
    }
  });
}
connectEvents();
window.addEventListener("offline", () => {
  events.close();
  disconnected();
});
window.addEventListener("online", connectEvents);
window.addEventListener("pagehide", () => events.close());
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});
