import { Niivue, SLICE_TYPE } from '@niivue/niivue';
import { getMatches } from '@tauri-apps/plugin-cli';
import { readFile } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';

const $ = (s) => document.querySelector(s);


/* =========================================================
   GLOBAL STATE
========================================================= */

let baseVolume = null;
let segmentations = [];
let nextSegId = 1;

const palette = [
  '#ff5c5c',
  '#4dd2ff',
  '#7ee787',
  '#ffd166',
  '#c77dff',
  '#ff8fab',
  '#72efdd',
  '#f4a261'
];


/* =========================================================
   LOCATION / VOXEL INTENSITY
========================================================= */

function handleLocationChange(data) {
  const status = $('#status');

  if (!status || !data?.vox) return;

  const x = Math.round(data.vox[0]);
  const y = Math.round(data.vox[1]);
  const z = Math.round(data.vox[2]);

  let intensity = null;

  if (Array.isArray(data.values) && data.values.length > 0) {
    const first = data.values[0];

    if (typeof first === 'number') {
      intensity = first;
    } else if (first && typeof first === 'object') {
      intensity =
        first.value ??
        first.val ??
        first.intensity ??
        first.raw ??
        null;
    }
  }

  let text = `Voxel: ${x}, ${y}, ${z}`;

  if (
    intensity !== null &&
    Number.isFinite(Number(intensity))
  ) {
    const n = Number(intensity);

    text += `   Intensity: ${
      Number.isInteger(n) ? n : n.toFixed(2)
    }`;
  }

  status.textContent = text;
}


/* =========================================================
   NIIVUE
========================================================= */

const nv = new Niivue({
  show3Dcrosshair: true,
  backColor: [0, 0, 0, 1],
  crosshairColor: [1, 0, 0, 1],
  isRadiologicalConvention: false,
  loadingText: '',
  onLocationChange: handleLocationChange
});

await nv.attachTo('gl');

window.nv = nv;

/*
 * IMPORTANT:
 *
 * true = nearest-neighbor interpolation in NiiVue.
 *
 * This applies globally to the viewer and prevents smoothing
 * of the base image and segmentation masks.
 */
nv.setInterpolation(true);


/* =========================================================
   GENERAL HELPERS
========================================================= */

function setBusy(on, title = 'Loading…', detail = '') {
  $('#loading').classList.toggle('hidden', !on);
  $('#loading-title').textContent = title;
  $('#loading-detail').textContent = detail;
}


function fileOkay(file) {
  return /\.nii(\.gz)?$/i.test(file?.name || '');
}


function updateGL() {
  nv.updateGLVolume();
  nv.drawScene();
}


function resetView() {
  if (nv.scene?.pan2Dxyzmm) {
    nv.scene.pan2Dxyzmm = [0, 0, 0, 1];
  }

  nv.drawScene();
}


function clearVolumes() {
  while (nv.volumes.length) {
    nv.removeVolume(nv.volumes[0]);
  }

  baseVolume = null;
  segmentations = [];
}


function hexToRgb(hex) {
  const value = hex.replace('#', '');

  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16)
  ];
}


function formatDims(volume) {
  const d = volume?.dims;

  return d?.length >= 4
    ? `${d[1]} × ${d[2]} × ${d[3]}`
    : '—';
}


function formatSpacing(volume) {
  const p = volume?.pixDims;

  return p?.length >= 4
    ? `${Number(p[1]).toFixed(2)} × ${Number(p[2]).toFixed(2)} × ${Number(p[3]).toFixed(2)} mm`
    : '—';
}


function formatIntensity(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return '—';

  return Number.isInteger(n)
    ? String(n)
    : n.toFixed(2);
}


/* =========================================================
   INTENSITY MIN / MAX
========================================================= */

function setIntensityRange(min, max) {
  if (!baseVolume) return;

  min = Number(min);
  max = Number(max);

  if (
    !Number.isFinite(min) ||
    !Number.isFinite(max) ||
    min >= max
  ) {
    return;
  }

  baseVolume.cal_min = min;
  baseVolume.cal_max = max;

  $('#window-range').textContent =
    `Display: ${formatIntensity(min)} to ${formatIntensity(max)}`;

  updateGL();
}


function initializeIntensityControls(volume) {
  if (!volume) return;

  let min = Number(volume.cal_min);
  let max = Number(volume.cal_max);

  if (!Number.isFinite(min)) min = 0;
  if (!Number.isFinite(max)) max = min + 1;
  if (max <= min) max = min + 1;

  const range = max - min;

  const sliderMin = min - range * 0.25;
  const sliderMax = max + range * 0.25;

  let step = 1;

  if (range <= 1) {
    step = 0.001;
  } else if (range <= 10) {
    step = 0.01;
  } else if (range <= 100) {
    step = 0.1;
  }

  $('#min-slider').min = sliderMin;
  $('#min-slider').max = sliderMax;
  $('#min-slider').step = step;
  $('#min-slider').value = min;

  $('#max-slider').min = sliderMin;
  $('#max-slider').max = sliderMax;
  $('#max-slider').step = step;
  $('#max-slider').value = max;

  $('#min-value').step = step;
  $('#min-value').value = min;

  $('#max-value').step = step;
  $('#max-value').value = max;

  $('#window-range').textContent =
    `Display: ${formatIntensity(min)} to ${formatIntensity(max)}`;
}


function updateIntensityFromInputs() {
  const min = Number($('#min-value').value);
  const max = Number($('#max-value').value);

  if (
    !Number.isFinite(min) ||
    !Number.isFinite(max) ||
    min >= max
  ) {
    return;
  }

  if (min < Number($('#min-slider').min)) {
    $('#min-slider').min = min;
    $('#max-slider').min = min;
  }

  if (max > Number($('#max-slider').max)) {
    $('#min-slider').max = max;
    $('#max-slider').max = max;
  }

  $('#min-slider').value = min;
  $('#max-slider').value = max;

  setIntensityRange(min, max);
}


/* =========================================================
   SEGMENTATION COLORS
========================================================= */

function applySegColor(item) {
  const [r, g, b] = hexToRgb(item.color);

  /*
   * Label 0 = transparent background
   * Label 1 = segmentation
   */
  const lut = {
    R: [0, r],
    G: [0, g],
    B: [0, b],
    A: [0, 255],
    I: [0, 1],
    labels: [
      'background',
      item.name
    ]
  };

  if (
    typeof item.volume.setColormapLabel === 'function'
  ) {
    item.volume.setColormapLabel(lut);
  } else {
    item.volume.colormapLabel = lut;
  }
}


/* =========================================================
   SEGMENTATION SIDEBAR
========================================================= */

function renderSegments() {
  const root = $('#segments');

  root.innerHTML = '';

  $('#seg-count').textContent =
    String(segmentations.length);

  const has = segmentations.length > 0;

  $('#show-all').disabled = !has;
  $('#hide-all').disabled = !has;
  $('#remove-all').disabled = !has;

  if (!has) {
    root.innerHTML =
      '<div class="empty-list">No segmentations loaded.</div>';

    return;
  }

  for (const item of segmentations) {
    const row = document.createElement('div');

    row.className = 'seg-row';

    row.innerHTML = `
      <div class="seg-head">

        <input
          class="visible"
          type="checkbox"
          ${item.visible ? 'checked' : ''}
          title="Show/hide"
        />

        <input
          class="color"
          type="color"
          value="${item.color}"
          title="Color"
        />

        <span
          class="seg-name"
          title="${item.name}"
        >${item.name}</span>

        <button
          class="remove"
          title="Remove segmentation"
        >✕</button>

      </div>

      <div class="seg-opacity">

        <span>Opacity</span>

        <input
          class="opacity"
          type="range"
          min="0"
          max="1"
          step="0.05"
          value="${item.opacity}"
        />

        <b>
          ${Math.round(item.opacity * 100)}%
        </b>

      </div>
    `;

    row
      .querySelector('.visible')
      .addEventListener('change', (e) => {
        item.visible = e.target.checked;

        item.volume.opacity =
          item.visible
            ? item.opacity
            : 0;

        updateGL();
      });

    row
      .querySelector('.color')
      .addEventListener('input', (e) => {
        item.color = e.target.value;

        applySegColor(item);
        updateGL();
      });

    row
      .querySelector('.opacity')
      .addEventListener('input', (e) => {
        item.opacity =
          Number(e.target.value);

        row
          .querySelector('.seg-opacity b')
          .textContent =
            `${Math.round(item.opacity * 100)}%`;

        if (item.visible) {
          item.volume.opacity =
            item.opacity;
        }

        updateGL();
      });

    row
      .querySelector('.remove')
      .addEventListener('click', () => {
        removeSegmentation(item.id);
      });

    root.append(row);
  }
}


/* =========================================================
   LOAD BASE IMAGE

   IMPORTANT:
   Both the GUI and CLI eventually call this SAME function.
========================================================= */

async function loadBaseImage(file) {
  if (!fileOkay(file)) {
    return alert(
      'Please choose a .nii or .nii.gz file.'
    );
  }

  setBusy(
    true,
    'Loading image…',
    file.name
  );

  try {
    clearVolumes();

    await nv.loadFromFile(file);

    baseVolume = nv.volumes[0];

    if (!baseVolume) {
      throw new Error(
        'NiiVue did not load the image.'
      );
    }

    baseVolume.colormap = 'gray';

    initializeIntensityControls(
      baseVolume
    );

    $('#image-name').textContent =
      file.name;

    $('#image-dims').textContent =
      formatDims(baseVolume);

    $('#image-spacing').textContent =
      formatSpacing(baseVolume);

    $('#status').textContent =
      file.name;

    $('#empty-state')
      .classList
      .add('hidden');

    $('#add-seg').disabled =
      false;

    renderSegments();
    updateGL();

  } catch (err) {
    console.error(err);

    alert(
      `Could not load image:\n${err.message || err}`
    );

  } finally {
    setBusy(false);
  }
}


/* =========================================================
   LOAD SEGMENTATIONS

   Also shared by GUI and CLI.
========================================================= */

async function addSegmentations(files) {
  if (!baseVolume) {
    return alert(
      'Open a base image first.'
    );
  }

  const valid =
    [...files].filter(fileOkay);

  if (!valid.length) return;

  setBusy(
    true,
    'Loading segmentations…',
    ''
  );

  try {
    for (const file of valid) {
      $('#loading-detail')
        .textContent =
          file.name;

      const before =
        nv.volumes.length;

      await nv.loadFromFile(file);

      const volume =
        nv.volumes[before];

      if (!volume) {
        throw new Error(
          `NiiVue did not load ${file.name}`
        );
      }

      const item = {
        id: nextSegId++,

        name:
          file.name.replace(
            /\.nii(\.gz)?$/i,
            ''
          ),

        volume,

        color:
          palette[
            segmentations.length %
            palette.length
          ],

        opacity: 0.55,
        visible: true
      };

      volume.opacity =
        item.opacity;

      applySegColor(item);

      segmentations.push(item);
    }

    renderSegments();
    updateGL();

  } catch (err) {
    console.error(err);

    alert(
      `Could not load segmentation:\n${err.message || err}`
    );

  } finally {
    setBusy(false);
  }
}


/* =========================================================
   REMOVE SEGMENTATION
========================================================= */

function removeSegmentation(id) {
  const index =
    segmentations.findIndex(
      (x) => x.id === id
    );

  if (index < 0) return;

  nv.removeVolume(
    segmentations[index].volume
  );

  segmentations.splice(
    index,
    1
  );

  renderSegments();
  updateGL();
}


/* =========================================================
   CLI SUPPORT
========================================================= */

/*
 * Extract the filename from either:
 *
 * /Users/me/data/image.nii.gz
 *
 * or:
 *
 * C:\\data\\image.nii.gz
 */
function filenameFromPath(path) {
  return String(path)
    .replace(/\\/g, '/')
    .split('/')
    .pop();
}


/*
 * Convert a filesystem path into a browser File.
 *
 * This is the key trick that lets the CLI reuse the exact
 * same NiiVue loading code as the GUI.
 */
async function fileFromPath(path) {
  const absolutePath = await invoke(
    'resolve_cli_path',
    { path }
  );

  const bytes =
    await readFile(absolutePath);

  return new File(
    [bytes],
    filenameFromPath(absolutePath),
    {
      type: 'application/octet-stream'
    }
  );
}


/*
 * CLI syntax:
 *
 * NiftiViewer image.nii.gz
 *
 * NiftiViewer image.nii.gz \
 *   --seg liver.nii.gz \
 *   --seg spleen.nii.gz
 */
async function handleCommandLine() {
  try {
    const matches =
      await getMatches();

    const imageArg =
      matches.args?.image?.value;

    const segArg =
      matches.args?.seg?.value;


    /*
     * No image argument:
     *
     * Do absolutely nothing.
     *
     * The application therefore behaves exactly like the
     * normal GUI viewer.
     */
    if (
      typeof imageArg !== 'string' ||
      !imageArg
    ) {
      return;
    }


    /*
     * Load base image.
     */

    const imageFile =
      await fileFromPath(
        imageArg
      );

    await loadBaseImage(
      imageFile
    );


    /*
     * --seg is configured as multiple:true, so Tauri can
     * return an array when one or more masks are supplied.
     */
    if (!segArg) {
      return;
    }


    const segPaths =
      Array.isArray(segArg)
        ? segArg
        : [segArg];


    const segFiles = [];

    for (
      const path of segPaths
    ) {
      const file =
        await fileFromPath(path);

      segFiles.push(file);
    }


    if (segFiles.length) {
      await addSegmentations(
        segFiles
      );
    }

  } catch (err) {
    console.error(
      'CLI loading failed:',
      err
    );

    alert(
      `Could not open command-line files:\n${err.message || err}`
    );
  }
}


/* =========================================================
   GUI FILE BUTTONS

   These work exactly as before.
========================================================= */

$('#open-image')
  .addEventListener(
    'click',
    () => {
      $('#image-input').click();
    }
  );


$('#add-seg')
  .addEventListener(
    'click',
    () => {
      $('#seg-input').click();
    }
  );


$('#image-input')
  .addEventListener(
    'change',
    async (e) => {
      if (e.target.files[0]) {
        await loadBaseImage(
          e.target.files[0]
        );
      }

      e.target.value = '';
    }
  );


$('#seg-input')
  .addEventListener(
    'change',
    async (e) => {
      await addSegmentations(
        e.target.files
      );

      e.target.value = '';
    }
  );


/* =========================================================
   MIN / MAX INTENSITY CONTROLS
========================================================= */

$('#min-slider')
  .addEventListener(
    'input',
    (e) => {
      let min =
        Number(e.target.value);

      const max =
        Number(
          $('#max-value').value
        );

      if (min >= max) {
        min =
          max -
          Number(
            e.target.step || 1
          );

        e.target.value = min;
      }

      $('#min-value').value =
        min;

      setIntensityRange(
        min,
        max
      );
    }
  );


$('#max-slider')
  .addEventListener(
    'input',
    (e) => {
      const min =
        Number(
          $('#min-value').value
        );

      let max =
        Number(e.target.value);

      if (max <= min) {
        max =
          min +
          Number(
            e.target.step || 1
          );

        e.target.value = max;
      }

      $('#max-value').value =
        max;

      setIntensityRange(
        min,
        max
      );
    }
  );


$('#min-value')
  .addEventListener(
    'change',
    () => {
      let min =
        Number(
          $('#min-value').value
        );

      const max =
        Number(
          $('#max-value').value
        );

      if (min >= max) {
        min =
          max -
          Number(
            $('#min-value').step || 1
          );

        $('#min-value').value =
          min;
      }

      updateIntensityFromInputs();
    }
  );


$('#max-value')
  .addEventListener(
    'change',
    () => {
      const min =
        Number(
          $('#min-value').value
        );

      let max =
        Number(
          $('#max-value').value
        );

      if (max <= min) {
        max =
          min +
          Number(
            $('#max-value').step || 1
          );

        $('#max-value').value =
          max;
      }

      updateIntensityFromInputs();
    }
  );


/* =========================================================
   VIEW CONTROLS
========================================================= */

for (
  const button of
  document.querySelectorAll(
    '[data-view]'
  )
) {
  button.addEventListener(
    'click',
    () => {
      const view =
        Number(
          button.dataset.view
        );

      if (view === 0) {
        nv.setSliceType(
          SLICE_TYPE.AXIAL
        );

      } else if (view === 1) {
        nv.setSliceType(
          SLICE_TYPE.CORONAL
        );

      } else if (view === 2) {
        nv.setSliceType(
          SLICE_TYPE.SAGITTAL
        );

      } else {
        nv.setSliceType(
          SLICE_TYPE.MULTIPLANAR
        );
      }

      document
        .querySelectorAll(
          '[data-view]'
        )
        .forEach((b) => {
          b.classList.toggle(
            'active',
            b === button
          );
        });
    }
  );
}


/* =========================================================
   RESET
========================================================= */

$('#reset')
  .addEventListener(
    'click',
    resetView
  );


/* =========================================================
   GLOBAL SEGMENTATION CONTROLS
========================================================= */

$('#show-all')
  .addEventListener(
    'click',
    () => {
      for (
        const item of segmentations
      ) {
        item.visible = true;

        item.volume.opacity =
          item.opacity;
      }

      renderSegments();
      updateGL();
    }
  );


$('#hide-all')
  .addEventListener(
    'click',
    () => {
      for (
        const item of segmentations
      ) {
        item.visible = false;
        item.volume.opacity = 0;
      }

      renderSegments();
      updateGL();
    }
  );


$('#remove-all')
  .addEventListener(
    'click',
    () => {
      for (
        const item of
        [...segmentations]
      ) {
        nv.removeVolume(
          item.volume
        );
      }

      segmentations = [];

      renderSegments();
      updateGL();
    }
  );


/* =========================================================
   KEYBOARD SHORTCUTS
========================================================= */

document.addEventListener(
  'keydown',
  (e) => {
    if (
      e.target.matches('input')
    ) {
      return;
    }

    if (
      e.key.toLowerCase() === 'r'
    ) {
      resetView();
    }

    if (
      '1234'.includes(e.key)
    ) {
      document
        .querySelector(
          `[data-view="${Number(e.key) - 1}"]`
        )
        ?.click();
    }
  }
);


/* =========================================================
   INITIAL STATE
========================================================= */

renderSegments();

nv.setSliceType(
  SLICE_TYPE.MULTIPLANAR
);


/*
 * Check CLI arguments LAST, after NiiVue and all UI
 * components are initialized.
 *
 * If the application was opened normally, this simply
 * returns and the GUI behaves exactly as before.
 */
await handleCommandLine();
