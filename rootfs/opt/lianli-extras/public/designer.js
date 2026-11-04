'use strict';

// Screen designer: drag widgets on a live preview rendered by the daemon.

const KIND_NAMES = {
  label: 'Text', value_text: 'Sensor value', radial_gauge: 'Round gauge', vertical_bar: 'Vertical bar', horizontal_bar: 'Horizontal bar',
  speedometer: 'Speedometer', core_bars: 'CPU core bars', image: 'Image', video: 'Video', sparkline: 'Line chart', clock_digital: 'Digital clock', clock_analog: 'Analog clock',
};
const SIZES = [[400, 400, 'TL / Flex LCD 400×400'], [480, 480, 'AIO 480×480'], [1472, 720, '1472×720'], [1080, 2288, '1080×2288'], [480, 1920, '480×1920'], [464, 1920, '464×1920']];
const PREVIEW_DELAY_MS = 200;
const DRAG_TIMED_KINDS = new Set(['video', 'clock_digital', 'clock_analog']);
const OPTIONS = { align: ['left', 'center', 'right'], fit: ['stretch', 'contain', 'cover'], orientation: ['horizontal', 'vertical'] };

let design = null;
let schema = null;
let fontsList = [];
let previewTimer_ = null;
let previewBusy = false;
let previewAgain = false;
let drag = null;

holds.push(() => tab === 'designer');

const pretty = (key) => {
  const text = key.replace(/_pct$/, '').replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};
const selected = () => design?.template.widgets.find((widget) => widget.id === design.selectedId) || null;
const newId = (prefix) => `${prefix}-${Date.now().toString(16)}-${Math.floor(Math.random() * 65536).toString(16)}`;

function widgetLabel(widget) {
  if (widget.kind.type === 'label') return widget.kind.text || 'Text';
  return KIND_NAMES[widget.kind.type] || widget.kind.type;
}

async function openDesigner(id) {
  try {
    if (!schema) {
      const [schemaResponse, fontsResponse] = await Promise.all([fetch('/api/design/schema'), fetch('/api/fonts')]);
      if (!schemaResponse.ok) throw await failure(schemaResponse);
      schema = (await schemaResponse.json()).widgets;
      fontsList = fontsResponse.ok ? await fontsResponse.json() : [];
    }
    let template;
    if (id) {
      const response = await fetch('/api/designs');
      if (!response.ok) throw await failure(response);
      template = (await response.json()).find((item) => item.id === id);
      if (!template) throw new Error('That design no longer exists');
    } else {
      const lcd = data.devices.find((device) => device.hasLcd && device.screenWidth);
      template = {
        id: newId('user'), name: `My screen ${data.designs.length + 1}`, base_width: lcd?.screenWidth || 400, base_height: lcd?.screenHeight || 400,
        background: { type: 'color', rgb: [0, 0, 0, 255] }, widgets: [], rotated: false, target_device: null,
      };
    }
    design = { template, selectedId: null, dirty: false, image: null };
    tab = 'designer';
    renderTabs();
    window.scrollTo(0, 0);
    renderDesigner();
    schedulePreview();
  } catch (error) {
    toast(error.message, true);
  }
}

function closeDesigner() {
  design = null;
  tab = 'screens';
  renderTabs();
  refresh(true);
}

function schedulePreview() {
  clearTimeout(previewTimer_);
  previewTimer_ = setTimeout(renderPreview, PREVIEW_DELAY_MS);
}

async function renderPreview() {
  if (!design) return;
  if (previewBusy) {
    previewAgain = true;
    return;
  }
  previewBusy = true;
  try {
    const response = await fetch('/api/design/preview', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lianli-Dashboard': '1' }, body: JSON.stringify({ template: design.template }) });
    const note = document.getElementById('stageNote');
    if (!response.ok) {
      if (note) note.textContent = (await failure(response)).message;
    } else {
      if (note) note.textContent = '';
      design.image = `data:image/jpeg;base64,${(await response.json()).jpeg_base64}`;
      const image = document.getElementById('stageImage');
      if (image) image.src = design.image;
    }
  } catch (error) {
    const note = document.getElementById('stageNote');
    if (note) note.textContent = error.message;
  } finally {
    previewBusy = false;
    if (previewAgain) {
      previewAgain = false;
      schedulePreview();
    }
  }
}

function boxStyle(widget) {
  const { base_width: width, base_height: height } = design.template;
  return `left:${((widget.x - widget.width / 2) / width) * 100}%;top:${((widget.y - widget.height / 2) / height) * 100}%;width:${(widget.width / width) * 100}%;height:${(widget.height / height) * 100}%;transform:rotate(${widget.rotation}deg);opacity:${widget.visible ? 1 : 0.35}`;
}

function stageBoxes() {
  return design.template.widgets.map((widget) => `<button class="box ${widget.id === design.selectedId ? 'on' : ''}" data-box="${esc(widget.id)}" style="${boxStyle(widget)}" aria-label="${esc(widgetLabel(widget))}"></button>`).join('');
}

function colorInput(key, value, attr) {
  return `<label>${esc(pretty(key))}<input type="color" ${attr} value="${hex(value.slice(0, 3))}"></label>`;
}

function rangesEditor(key, list) {
  const isStops = key === 'gradient_stops';
  return `<div class="wide"><h3>${isStops ? 'Gradient' : 'Colour steps'}</h3>
    ${list.map((item, index) => `<div class="points" data-list="${key}" data-item="${index}">
      <label>${isStops ? 'Position %' : 'Up to (blank for the rest)'}<input type="number" data-item-value value="${isStops ? item.position : item.max ?? ''}"></label>
      <label>Colour<input type="color" data-item-color value="${hex(item.color)}"></label>
      <button class="btn" data-item-remove aria-label="Remove">×</button>
    </div>`).join('')}
    <div class="actions"><button class="btn" data-item-add="${key}">Add</button></div></div>`;
}

function propertyField(key, value) {
  const attr = `data-prop="${key}"`;
  if (key === 'type') return '';
  if (key === 'source') {
    const current = JSON.stringify(value);
    const known = data.sources.some((source) => source.id === current);
    return `<label class="wide">Sensor<select data-prop-source>${data.sources.map((source) => option(source.id, source.name, source.id === current)).join('')}${known ? '' : `<option value="${esc(current)}" selected>Current sensor</option>`}</select></label>`;
  }
  if (key === 'path') {
    const video = selected().kind.type === 'video';
    const files = data.media.filter((file) => (video ? /\.(gif|mp4|webm|mkv|mov|avi|m4v|apng|png)$/i : /\.(png|jpe?g|bmp|webp|gif)$/i).test(file));
    const known = files.includes(value);
    return `<label class="wide">File<select ${attr}>${option('', 'Choose a file', !value)}${files.map((file) => option(file, fileName(file), file === value)).join('')}${known || !value ? '' : `<option value="${esc(value)}" selected>${esc(fileName(value))}</option>`}</select></label>`;
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && 'path' in value) {
    const known = !value.path || fontsList.some((font) => font.path === value.path);
    return `<label class="wide">${esc(pretty(key))}<select data-prop-font="${key}">${option('', 'Default', !value.path)}${fontsList.map((font) => option(font.path, font.name, font.path === value.path)).join('')}${known ? '' : `<option value="${esc(value.path)}" selected>${esc(fileName(value.path))}</option>`}</select></label>`;
  }
  if (key === 'ranges' || key === 'gradient_stops') return rangesEditor(key, value);
  if (Array.isArray(value)) return colorInput(key, value, `data-prop-color="${key}"`);
  if (typeof value === 'boolean') return toggle(attr, esc(pretty(key)), value);
  if (OPTIONS[key]) return `<label>${esc(pretty(key))}<select ${attr}>${OPTIONS[key].map((item) => option(item, pretty(item), item === value)).join('')}</select></label>`;
  if (typeof value === 'number') {
    const percent = key.endsWith('_pct') || key === 'opacity';
    return `<label>${esc(pretty(key))}${percent ? ' (%)' : ''}<input type="number" step="${percent ? 1 : 'any'}" ${attr} ${percent ? 'data-percent' : ''} value="${percent ? Math.round(value * 100) : value}"></label>`;
  }
  return `<label class="${key === 'text' ? 'wide' : ''}">${esc(pretty(key))}<input type="text" maxlength="512" ${attr} value="${esc(value)}"></label>`;
}

function propertiesPanel() {
  const widget = selected();
  if (!widget) return '<p class="muted">Add a widget, or select one to change it.</p>';
  const hasSource = 'source' in widget.kind;
  const timed = DRAG_TIMED_KINDS.has(widget.kind.type);
  const field = (key, text, step = 1) => `<label>${text}<input type="number" step="${step}" data-geo="${key}" value="${widget[key]}"></label>`;
  return `<h3>${esc(KIND_NAMES[widget.kind.type] || widget.kind.type)}</h3>
    ${widget.sensor_category ? `<p class="warn">Needs a ${esc(widget.sensor_category.replace(/_/g, ' '))} sensor. Choose one below to bring it to life.</p>` : ''}
    <div class="prop-grid">
      ${field('x', 'Centre X')}${field('y', 'Centre Y')}${field('width', 'Width')}${field('height', 'Height')}${field('rotation', 'Rotation °')}
      ${hasSource ? `<label>Update every (ms)<input type="number" min="100" max="10000" step="100" data-geo-opt="update_interval_ms" value="${widget.update_interval_ms ?? ''}" placeholder="Default"></label>` : ''}
      ${timed ? `<label>Frame rate<input type="number" min="1" max="120" data-geo-opt="fps" value="${widget.fps ?? ''}" placeholder="Default"></label>` : ''}
    </div>
    ${toggle('data-visible', 'Visible', widget.visible)}
    <div class="prop-grid">${Object.entries(widget.kind).map(([key, value]) => propertyField(key, value)).join('')}</div>`;
}

function widgetList() {
  const { widgets } = design.template;
  return widgets.map((widget, index) => `<div class="w-row ${widget.id === design.selectedId ? 'on' : ''}">
    <button class="w-name" data-pick="${esc(widget.id)}">${esc(widgetLabel(widget))}</button>
    <button class="btn" data-move="-1" data-w="${esc(widget.id)}" aria-label="Move back" ${index === 0 ? 'disabled' : ''}>↑</button>
    <button class="btn" data-move="1" data-w="${esc(widget.id)}" aria-label="Move forward" ${index === widgets.length - 1 ? 'disabled' : ''}>↓</button>
    <button class="btn" data-copy="${esc(widget.id)}" aria-label="Duplicate">⧉</button>
    <button class="btn danger" data-drop="${esc(widget.id)}" aria-label="Delete">×</button>
  </div>`).join('') || '<p class="muted">No widgets yet.</p>';
}

function renderDesigner() {
  if (!design) {
    tab = 'screens';
    renderTabs();
    RENDER.screens();
    return;
  }
  const { template } = design;
  const size = `${template.base_width}x${template.base_height}`;
  const sizes = SIZES.some(([width, height]) => `${width}x${height}` === size) ? SIZES : [[template.base_width, template.base_height, `${template.base_width}×${template.base_height}`], ...SIZES];
  const background = template.background;
  view.innerHTML = `<div class="toolbar designer-bar">
      <button class="btn" id="dBack">Back</button>
      <button class="btn primary" id="dSave">Save design</button>
    </div>
    <div class="designer">
      <div class="card stage-card">
        <div class="stage" id="stage" style="aspect-ratio:${template.base_width}/${template.base_height};width:min(100%,calc(72vh*${template.base_width / template.base_height}))">
          <img id="stageImage" alt="Preview of this design" ${design.image ? `src="${esc(design.image)}"` : ''}>
          <div id="boxes">${stageBoxes()}</div>
        </div>
        <p class="muted" id="stageNote" role="status"></p>
      </div>
      <div class="designer-side">
        <div class="card">
          <label style="margin-top:0">Name<input type="text" maxlength="80" id="dName" value="${esc(template.name)}"></label>
          <div class="two">
            <label>Screen size<select id="dSize">${sizes.map(([width, height, label]) => option(`${width}x${height}`, label, `${width}x${height}` === size)).join('')}</select></label>
            <label>Background<input type="color" id="dBackground" value="${background.type === 'color' ? hex(background.rgb.slice(0, 3)) : '#000000'}"></label>
          </div>
          <label>Background image<select id="dBackgroundImage">
            ${option('', 'None', background.type !== 'image')}
            ${data.media.filter((file) => /\.(png|jpe?g|bmp|webp)$/i.test(file)).map((file) => option(file, fileName(file), background.path === file)).join('')}
            ${background.type === 'image' && !data.media.includes(background.path) ? `<option value="${esc(background.path)}" selected>${esc(fileName(background.path))}</option>` : ''}
          </select></label>
          ${template.base_width !== template.base_height ? toggle('id="dRotated"', 'Sideways', template.rotated) : ''}
        </div>
        <div class="card">
          <div class="card-head"><h2>Widgets</h2></div>
          <div id="wList">${widgetList()}</div>
          <label>Add a widget<select id="dAdd">${option('', 'Choose…', true)}${Object.keys(schema).map((kind) => option(kind, KIND_NAMES[kind] || kind)).join('')}</select></label>
        </div>
        <div class="card" id="props">${propertiesPanel()}</div>
      </div>
    </div>`;
}

function touched({ preview = true } = {}) {
  design.dirty = true;
  if (preview) schedulePreview();
}

function refreshStage() {
  const boxes = document.getElementById('boxes');
  if (boxes) boxes.innerHTML = stageBoxes();
}

function rerenderSide() {
  document.getElementById('wList').innerHTML = widgetList();
  document.getElementById('props').innerHTML = propertiesPanel();
  refreshStage();
}

function addWidget(kind) {
  const { template } = design;
  const widget = { id: newId('w'), kind: JSON.parse(JSON.stringify(schema[kind])), x: Math.round(template.base_width / 2), y: Math.round(template.base_height / 2), width: 120, height: 60, rotation: 0, visible: true };
  template.widgets.push(widget);
  design.selectedId = widget.id;
  rerenderSide();
  touched();
}

function setRotated(on) {
  const { template } = design;
  if (template.rotated === on) return;
  const [oldWidth, oldHeight] = [template.base_width, template.base_height];
  for (const widget of template.widgets) {
    const [cx, cy] = [widget.x, widget.y];
    if (on) {
      widget.x = oldHeight - cy;
      widget.y = cx;
    } else {
      widget.x = cy;
      widget.y = oldWidth - cx;
    }
    [widget.width, widget.height] = [widget.height, widget.width];
  }
  template.base_width = oldHeight;
  template.base_height = oldWidth;
  template.rotated = on;
  renderDesigner();
  touched();
}

function pointerToBase(event) {
  const box = document.getElementById('stage').getBoundingClientRect();
  return { x: ((event.clientX - box.left) / box.width) * design.template.base_width, y: ((event.clientY - box.top) / box.height) * design.template.base_height };
}

view.addEventListener('pointerdown', (event) => {
  const box = event.target.closest?.('[data-box]');
  if (!box || tab !== 'designer') return;
  event.preventDefault();
  design.selectedId = box.dataset.box;
  const widget = selected();
  const point = pointerToBase(event);
  drag = { id: widget.id, dx: point.x - widget.x, dy: point.y - widget.y, moved: false };
  rerenderSide();
});

window.addEventListener('pointermove', (event) => {
  if (!drag || !design) return;
  const widget = design.template.widgets.find((item) => item.id === drag.id);
  const point = pointerToBase(event);
  widget.x = Math.round(point.x - drag.dx);
  widget.y = Math.round(point.y - drag.dy);
  drag.moved = true;
  const element = view.querySelector(`[data-box="${CSS.escape(widget.id)}"]`);
  if (element) element.setAttribute('style', boxStyle(widget));
});

window.addEventListener('pointerup', () => {
  if (!drag) return;
  const { moved } = drag;
  drag = null;
  if (moved && design) {
    document.getElementById('props').innerHTML = propertiesPanel();
    touched();
  }
});

window.addEventListener('keydown', (event) => {
  if (tab !== 'designer' || !design || /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName)) return;
  const widget = selected();
  if (!widget) return;
  const step = event.shiftKey ? 10 : 1;
  const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (moves[event.key]) {
    event.preventDefault();
    widget.x += moves[event.key][0];
    widget.y += moves[event.key][1];
    rerenderSide();
    touched();
  } else if (event.key === 'Delete') {
    design.template.widgets = design.template.widgets.filter((item) => item !== widget);
    design.selectedId = null;
    rerenderSide();
    touched();
  }
});

// Leaving through the tabs asks too, and closes the design.
document.addEventListener('click', (event) => {
  if (tab !== 'designer' || !event.target.closest?.('[data-tab]')) return;
  if (design?.dirty && !window.confirm('Leave without saving your changes?')) {
    event.stopPropagation();
    event.preventDefault();
    return;
  }
  design = null;
}, true);

window.addEventListener('beforeunload', (event) => {
  if (design?.dirty) event.preventDefault();
});

view.addEventListener('input', (event) => {
  if (tab !== 'designer' || !design) return;
  const { target } = event;
  const widget = selected();
  const set = target.dataset;
  if (target.id === 'dName') {
    design.template.name = target.value;
    touched({ preview: false });
  } else if (!widget) {
    return;
  } else if (set.geo) {
    const value = Number(target.value);
    if (target.value !== '' && Number.isFinite(value)) {
      widget[set.geo] = value;
      refreshStage();
      touched();
    }
  } else if (set.prop && target.type !== 'checkbox' && target.tagName !== 'SELECT') {
    if (target.type === 'number') {
      const value = Number(target.value);
      if (target.value === '' || !Number.isFinite(value)) return;
      widget.kind[set.prop] = set.percent !== undefined ? value / 100 : value;
    } else {
      widget.kind[set.prop] = target.value;
    }
    touched();
  } else if (set.propColor) {
    const old = widget.kind[set.propColor];
    widget.kind[set.propColor] = old.length === 4 ? [...rgbOf(target.value), old[3]] : rgbOf(target.value);
    touched();
  }
});

view.addEventListener('change', (event) => {
  if (tab !== 'designer' || !design) return;
  const { target } = event;
  const { template } = design;
  const widget = selected();
  const set = target.dataset;
  if (target.id === 'dSize') {
    const [width, height] = target.value.split('x').map(Number);
    template.base_width = width;
    template.base_height = height;
    template.rotated = false;
    renderDesigner();
    touched();
  } else if (target.id === 'dBackground') {
    template.background = { type: 'color', rgb: [...rgbOf(target.value), 255] };
    document.getElementById('dBackgroundImage').value = '';
    touched();
  } else if (target.id === 'dBackgroundImage') {
    template.background = target.value ? { type: 'image', path: target.value } : { type: 'color', rgb: [...rgbOf(document.getElementById('dBackground').value), 255] };
    touched();
  } else if (target.id === 'dRotated') {
    setRotated(target.checked);
  } else if (target.id === 'dAdd') {
    if (target.value) addWidget(target.value);
    target.value = '';
  } else if (!widget) {
    return;
  } else if (target.matches('[data-visible]')) {
    widget.visible = target.checked;
    refreshStage();
    touched();
  } else if (set.geoOpt) {
    if (target.value === '') delete widget[set.geoOpt];
    else widget[set.geoOpt] = Number(target.value);
    touched();
  } else if (target.matches('[data-prop-source]')) {
    widget.kind.source = JSON.parse(target.value);
    delete widget.sensor_category;
    document.getElementById('props').innerHTML = propertiesPanel();
    touched();
  } else if (set.propFont) {
    widget.kind[set.propFont] = { path: target.value || null };
    touched();
  } else if (set.prop && target.type === 'checkbox') {
    widget.kind[set.prop] = target.checked;
    touched();
  } else if (set.prop && target.tagName === 'SELECT') {
    widget.kind[set.prop] = target.value;
    touched();
  } else if (target.matches('[data-item-value], [data-item-color]')) {
    const row = target.closest('[data-item]');
    const item = widget.kind[row.dataset.list][Number(row.dataset.item)];
    if (target.matches('[data-item-color]')) item.color = rgbOf(target.value);
    else if (row.dataset.list === 'gradient_stops') item.position = Number(target.value);
    else item.max = target.value === '' ? null : Number(target.value);
    touched();
  }
});

view.addEventListener('click', async (event) => {
  const target = event.target.closest('button');
  if (!target) return;
  const set = target.dataset;
  if (set.designNew !== undefined) return openDesigner(null);
  if (set.designEdit) return openDesigner(set.designEdit);
  if (set.designDelete) {
    if (window.confirm('Delete this design?')) act('/api/design/delete', { id: set.designDelete }, 'Deleted');
    return undefined;
  }
  if (tab !== 'designer' || !design) return undefined;
  const { template } = design;
  const widget = selected();
  if (target.id === 'dBack') {
    if (!design.dirty || window.confirm('Leave without saving your changes?')) closeDesigner();
  } else if (target.id === 'dSave') {
    if (template.widgets.some((item) => item.kind.path === '')) {
      toast('Choose a file for each image and video widget', true);
      return undefined;
    }
    target.disabled = true;
    try {
      const response = await fetch('/api/design/save', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lianli-Dashboard': '1' }, body: JSON.stringify({ template }) });
      if (!response.ok) throw await failure(response);
      design.dirty = false;
      toast('Saved. It is in the Shows list under Your designs.');
    } catch (error) {
      toast(error.message, true);
    }
    target.disabled = false;
  } else if (set.pick) {
    design.selectedId = set.pick;
    rerenderSide();
  } else if (set.move) {
    const index = template.widgets.findIndex((item) => item.id === set.w);
    const other = index + Number(set.move);
    [template.widgets[index], template.widgets[other]] = [template.widgets[other], template.widgets[index]];
    rerenderSide();
    touched();
  } else if (set.copy) {
    const original = template.widgets.find((item) => item.id === set.copy);
    const clone = { ...JSON.parse(JSON.stringify(original)), id: newId('w'), x: original.x + 10, y: original.y + 10 };
    template.widgets.push(clone);
    design.selectedId = clone.id;
    rerenderSide();
    touched();
  } else if (set.drop) {
    template.widgets = template.widgets.filter((item) => item.id !== set.drop);
    if (design.selectedId === set.drop) design.selectedId = null;
    rerenderSide();
    touched();
  } else if (set.itemAdd && widget) {
    const list = widget.kind[set.itemAdd];
    list.push(set.itemAdd === 'gradient_stops' ? { position: 100, color: [255, 255, 255], alpha: 255 } : { max: null, color: [255, 255, 255], alpha: 255 });
    document.getElementById('props').innerHTML = propertiesPanel();
    touched();
  } else if (set.itemRemove !== undefined && widget) {
    const row = target.closest('[data-item]');
    widget.kind[row.dataset.list].splice(Number(row.dataset.item), 1);
    document.getElementById('props').innerHTML = propertiesPanel();
    touched();
  }
  return undefined;
});
