// Llama Playground — the whole scene and everything in it (three.js, as an ES module).
// Laid out in sections; search for "// ---------- " to jump between them. Optional extras each
// have an on/off constant and tag their small hooks elsewhere (ramp:, paint:, sfx:, gather:, ...).
// Served over http (see start.command): browsers won't load a module from a file:// page.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as CANNON from 'cannon-es';   // piles: the physics for the toppling stacks

// ---------- review params ----------
// ?speed=4   walk at a fixed speed in profile (camera follows)
// ?slow=0.25 slow time down
// ?phase=0.3 simulate until the gait cycle reaches this point, then freeze
// ?zoom=2    magnify
const params = new URLSearchParams(location.search);
const FIXED_SPEED = params.has('speed') ? parseFloat(params.get('speed')) : null;
const FIXED_PHASE = params.has('phase') ? parseFloat(params.get('phase')) : null;
const TIME_SCALE = parseFloat(params.get('slow') || '1');
const ZOOM = parseFloat(params.get('zoom') || '0.6'); // starts zoomed out to fit the herd
// the "controls" button and its panel. Hidden, nothing saved from the panel before is used
// either (it couldn't be changed back): sound, music, tune, rain and blight are as set here.
const CONTROLS = false;       // ← true: show the controls
const saved = (key) => { if (!CONTROLS) return null; try { return localStorage.getItem(key); } catch { return null; } };

// ---------- palette ----------
const C = {
  black: new THREE.Color(0x000000),
  eye:   0xdddddd,
  nose:  0xf07a76,
  marker: 0xe2e2e2,
};
const mat = (c) => new THREE.MeshBasicMaterial({ color: c });
// Geometry is shared: every llama reuses one capsule per size. The figures are flat silhouettes,
// so 5 cap / 16 radial segments are plenty (facets stay well under a pixel at normal zoom)
// at ~40% of the triangles of the old 8 / 24.
const _geo = new Map();
const shared = (key, make) => _geo.get(key) ?? _geo.set(key, make()).get(key);
const capsule = (r, len) => shared(`c${r}/${len}`, () => new THREE.CapsuleGeometry(r, len, 5, 16));
const mBlack = mat(C.black);
// coats: body colour + a slightly lighter shade for the legs on the far side
// far-side leg shade from a body colour: dark coats go a touch lighter, light coats a touch darker
function coatFrom(body) {
  const c = new THREE.Color(body), hsl = {};
  c.getHSL(hsl);
  return { body: c.getHex(), far: new THREE.Color().setHSL(hsl.h, hsl.s, hsl.l < 0.3 ? hsl.l + 0.1 : hsl.l - 0.07).getHex() };
}
// coats offered to new llamas
// the herd palette (plus black for yours): coral, blush, peach, sage, green — the starting herd —
// then, for llamas added in the panel: butter, dusty blue, terracotta, mauve, teal, oat
const COAT_CHOICES = [0xe9505e, 0xf0a29e, 0xf6d2b2, 0xc3c8aa, 0x86ad96,
                      0xf1d68e, 0xa3bccd, 0xd9886b, 0xc6a1b5, 0x6f9893, 0xe3d7c1];
const COATS = {
  black:   { body: 0x000000, far: 0x2a2a2a },
};

// ---------- renderer / scene / camera ----------
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0xffffff);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.matrixWorldAutoUpdate = false; // updated once per frame in render(), before the batches are filled
const BASE_VIEW = 42;
let VIEW = BASE_VIEW / ZOOM; // world units visible vertically (zoom slider / wheel)
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
// camera orbits the origin: orbit = angle around, tilt = angle above the ground
const CAM_DIST = 90;
let camOrbit = 26.6, camTilt = 29.9;    // matches the original (35, 45, 70) offset
const CAM_OFFSET = new THREE.Vector3();
const camDir = new THREE.Vector3();     // unit vector from the scene toward the camera
let CAM_HEADING = 0;                    // body heading that faces the viewer
function placeCamera() {
  const az = THREE.MathUtils.degToRad(camOrbit), el = THREE.MathUtils.degToRad(camTilt);
  camDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
  CAM_OFFSET.copy(camDir).multiplyScalar(CAM_DIST);
  CAM_HEADING = Math.atan2(-camDir.z, camDir.x);
  camera.position.copy(CAM_OFFSET);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(); // ground picking (spawns, wander spots) needs this before the first frame
}
placeCamera();

function resize() {
  const w = innerWidth, h = innerHeight, a = w / h;
  renderer.setSize(w, h);
  camera.left = -VIEW * a / 2; camera.right = VIEW * a / 2;
  camera.top = VIEW / 2; camera.bottom = -VIEW / 2;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---------- math ----------
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const smoother = (x) => { x = clamp(x, 0, 1); return x * x * x * (x * (x * 6 - 15) + 10); };
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));

// ---------- face geometry (shared by all llamas) ----------
const EYES_GEO = mergeGeometries([-1, 1].map((s) => new THREE.SphereGeometry(0.14, 12, 8).translate(0, 0, s * 0.52)));
function tinted(geo, hex) {   // bake a flat colour into a geometry (for vertex-coloured merging)
  const c = new THREE.Color(hex), n = geo.attributes.position.count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}
// blight: X X eyes for a llama that has keeled over — a little cross over each eye, facing out
const X_EYES_GEO = mergeGeometries([-1, 1].flatMap((s) => {
  const n = new THREE.Vector3(0.72, 0.42, s * 0.52).normalize(), q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  return [1, -1].map((d) => new THREE.BoxGeometry(0.42, 0.09, 0.05).rotateZ(d * Math.PI / 4).applyQuaternion(q)
    .translate(n.x * 0.06, n.y * 0.06, s * 0.52 + n.z * 0.06));
}));
const MUZZLE_GEO = mergeGeometries([
  tinted(new THREE.CapsuleGeometry(0.22, 0.4, 4, 12).rotateX(Math.PI / 2).translate(0.9, 0.33, 0), C.nose),
  tinted(new THREE.BoxGeometry(0.05, 0.06, 0.42).translate(1.12, 0.33, 0), 0x000000),
]);
const MUZZLE_MAT = new THREE.MeshBasicMaterial({ vertexColors: true });

// ---------- instanced drawing ----------
// Every llama is built from the same few shapes, so each shape is drawn for ALL llamas in a
// single instanced draw call (per-instance matrix + colour). The llamas themselves are just
// invisible transform skeletons; each frame their part transforms are copied into the batches.
// Draw calls stay ~constant no matter how many llamas there are.
const BATCH_CAP = 32;              // max uses of one shape per frame (12 llamas × 2 legs/ears)
const batches = new Map();         // geometry → { mesh, n, tint }
function batchFor(geo, { tint = true, shadow = true, material = null } = {}) {
  let b = batches.get(geo);
  if (!b) {
    const mesh = new THREE.InstancedMesh(geo, material ?? new THREE.MeshBasicMaterial(), BATCH_CAP);
    mesh.frustumCulled = false;    // instances spread across the scene; the base bounds don't apply
    mesh.castShadow = shadow;
    mesh.count = 0;
    if (tint) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(BATCH_CAP * 3), 3);
    scene.add(mesh);
    b = { mesh, n: 0, tint };
    batches.set(geo, b);
  }
  return b;
}
// ramp: rainbow coat — hue bands by height that scroll upward, blended in by `amount`
const _rb = new THREE.Color(), _rb2 = new THREE.Color();
function rainbowOf(part, amount) {
  const h = (((performance.now() / 1000) * 0.9 - part.obj.matrixWorld.elements[13] * 0.08) % 1 + 1) % 1;
  return _rb2.copy(part.color).lerp(_rb.setHSL(h, 0.75, 0.62), amount);
}
function drawHerd() {
  for (const b of batches.values()) b.n = 0;
  for (const l of llamas) for (const part of l.parts) {
    if (introOn && l === player) break;   // intro: yours appears on the snap
    const b = part.batch;
    if (b.n >= BATCH_CAP) continue;
    b.mesh.setMatrixAt(b.n, part.obj.matrixWorld);
    if (b.tint) b.mesh.setColorAt(b.n, l.rainbow > 0 && part.fur ? rainbowOf(part, l.rainbow) : part.color); // ramp:
    b.n++;
  }
  for (const b of batches.values()) {
    b.mesh.count = b.n;
    b.mesh.instanceMatrix.needsUpdate = true;
    if (b.tint) b.mesh.instanceColor.needsUpdate = true;
  }
}

// ---------- llama anatomy (shared) ----------
// Units: 1 = 100px of the mockup. Local +x is forward, +y up.
const RIG_Y = 4.5;              // body center height when standing
const NECK_LEN = 3.95, NECK_TILT = -Math.atan2(0.6, 3.9);
// Two-bone IK in each leg's sagittal plane.
// Front: forearm + cannon. Standing, it's a straight vertical column; the carpus folds forward in swing.
// Hind:  gaskin + cannon. Standing, the gaskin angles back to the hock and the cannon hangs vertical.
// Hip (shoulder/stifle) sits 0.5 below body center → 3.45 above the foot centers when standing.
const LEG_R = 0.55, FOOT_Y = LEG_R, HIP_Y = -0.5, LEG_Z = 0.52;
const HOCK_BACK = 0.45;                 // how far the hock (and foot) sits behind the stifle when standing

// Lengths are tuned for the soft IK below: standing, the front leg is a near-straight post (~9° knee)
// and the hind cannon hangs exactly vertical.
const SOFT = 0.08;                      // soft-IK zone: reach eases out over the last 0.08 instead of clipping
const MAX_STRETCH = 1.08;
const FRONT = { L1: 1.862, L2: 1.498 };
const HIND  = { L1: 1.957, L2: 1.5 };


// Gaits. td = touchdown time of each foot within the cycle (0..1).
//  walk:   lateral-sequence with lateral couplets (LH → LF → RH → RF), camelid style
//  pace:   lateral pairs move together; the llama's natural fast gait, body rolls
//  gallop: rotary (LH → RH → RF → LF) with a gathered suspension at ~0.93
// cadence = strides per second at the gait's reference speed (ref); drop = how much the body crouches
const GAITS = {
  walk:   { duty: 0.68, ref: 2.0,  cadence: 0.85, drop: 0.05, liftF: 0.60, liftH: 0.40, td: { LH: 0.00, LF: 0.18, RH: 0.50, RF: 0.68 } },
  pace:   { duty: 0.52, ref: 5.5,  cadence: 1.25, drop: 0.12, liftF: 0.85, liftH: 0.55, td: { LH: 0.00, LF: 0.04, RH: 0.50, RF: 0.54 } },
  gallop: { duty: 0.36, ref: 13.0, cadence: 1.65, drop: 0.30, liftF: 1.50, liftH: 0.90, td: { LH: 0.00, LF: 0.50, RH: 0.10, RF: 0.40 } },
};
// Kush (lying down): legs fold flat under the body. The hip ends up 0.4 above the foot;
// the front foot tucks 0.35 ahead of the shoulder (knee folds forward along the ground),
// the hind foot 0.43 behind the stifle (hock folds back along the ground).
const KUSH_HIP_Y = FOOT_Y + 0.4;
const KUSH_FOOT = { front: 0.35, hind: -0.43 };
const MAX_STRIDE = 3.0;  // never let a foot sweep further than this during stance
// Limb protraction. In real quadrupeds the whole limb swings from the hip (hind) / shoulder
// (front), so the stifle and elbow travel forward and back with each step; the hock and knee
// only add the fold. Without this, a pinned stifle forces the hock to kick backward while the
// foot swings forward (an "inverted" look). The joint follows this fraction of the foot's
// offset, evaluated a little ahead in the cycle (LEAD): the knee leads, the foot trails behind
// it after lift-off, then catches up and reaches out before landing.
const PROTRACT = { front: 0.25, hind: 0.5 };
const LEAD = { front: 0.05, hind: 0.1 };
const F_MIN = 0.8;       // slowest cadence while moving / stepping in place

// ---------- cast shadow ----------
// A high "sun" projects the real silhouette onto the ground as a flat pale grey.
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
const SUN_DIR = new THREE.Vector3(-0.9, 4, 0).normalize(); // high sun: shadow sits close under the figure
const sun = new THREE.DirectionalLight(0xffffff, 1);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048); // crisp enough for thin gate bars; only the casters are redrawn
Object.assign(sun.shadow.camera, { near: 1, far: 120 }); // extent is fitted to the llamas each frame
sun.shadow.camera.updateProjectionMatrix();
scene.add(sun, sun.target);
// only as big as the shadow area (re-fitted with it), so the rest of the screen costs nothing
const groundShadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.07 }));
groundShadow.rotation.x = -Math.PI / 2;
groundShadow.receiveShadow = true;
scene.add(groundShadow);

// Fit the shadow area around all llamas (and loose balls): tight when they're together so the
// shadow stays crisp, wider when they spread out, whatever the camera zoom.
const _look = new THREE.Vector3();
let shadowHalf = 0;
function render() {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0, n = llamas.length + balls.length + loose.length; i < n; i++) {
    const p = i < llamas.length ? llamas[i].group.position
      : i < llamas.length + balls.length ? balls[i - llamas.length].pos : loose[i - llamas.length - balls.length].tr.pos;
    if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z;
  }
  if (piles) for (const { body: b } of piles.pieces) { // piles: the pieces' shadows too
    if (b.position.x < x0) x0 = b.position.x; if (b.position.x > x1) x1 = b.position.x;
    if (b.position.z < z0) z0 = b.position.z; if (b.position.z > z1) z1 = b.position.z;
  }
  if (ramp) { // ramp: its shadow is covered too
    const e = RAMP_LEN / 2 + RAMP_H * 0.3;
    x0 = Math.min(x0, ramp.x - e); x1 = Math.max(x1, ramp.x + e); z0 = Math.min(z0, ramp.z - e); z1 = Math.max(z1, ramp.z + e);
  }
  _look.set((x0 + x1) / 2, 0, (z0 + z1) / 2);
  const half = Math.max(20, Math.max(x1 - x0, z1 - z0) / 2 + 14);
  if (Math.abs(half - shadowHalf) > 1) {   // only re-fit when it changes meaningfully
    shadowHalf = Math.ceil(half);
    Object.assign(sun.shadow.camera, { left: -shadowHalf, right: shadowHalf, top: shadowHalf, bottom: -shadowHalf });
    sun.shadow.camera.updateProjectionMatrix();
    groundShadow.scale.set(shadowHalf * 2.4, shadowHalf * 2.4, 1);
  }
  groundShadow.position.set(_look.x, 0, _look.z);
  sun.target.position.copy(_look);
  sun.position.copy(_look).addScaledVector(SUN_DIR, 60);
  scene.updateMatrixWorld();
  drawHerd();
  renderer.render(scene, camera);
  introLayer?.draw();                       // intro: the butterfly above the title card
  if (glitch.mesh) drawGlitch();            // ramp: the summit glitch (blight: your llama's), over it
}

// ---------- cursor marker ----------

const marker = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.7, 40), mat(C.marker));
marker.rotation.x = -Math.PI / 2;
marker.position.y = 0.02;
marker.visible = false;
scene.add(marker);
const _up = new THREE.Vector3(0, 1, 0), _n = new THREE.Vector3(), _flat = marker.quaternion.clone();

// ---------- input ----------
const target = new THREE.Vector3();
const ray = new THREE.Raycaster();
const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const ndc = new THREE.Vector2();
const hint = document.getElementById('hint');
let hasTarget = false;
let petX = 0, petY = 0, petAt = 0; // pet: the last pointer sample, for stroke speed
let pointerIdle = 0;           // seconds since the cursor last moved
let pointerOn = null;          // the llama directly under the pointer, if any
let lastPX = 0, lastPY = 0;
// touch: there's no hover, so a finger leads the llama while it's down (a tap sends it there), a
// double-tap drops a ball, rubbing a llama pets it (holding still still herds), two fingers pinch-zoom
const TOUCH = matchMedia('(pointer: coarse)').matches;
const touches = new Map();     // active touch points, by pointer id
let pinch = null;              // { d, z }: finger spread and zoom when the pinch began
let lastTap = null;            // { t, x, y }: the last tap on the ground, for double-taps
const spread = () => { const [a, b] = [...touches.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
if (TOUCH) hint.textContent = 'drag to lead your llama';
document.addEventListener('gesturestart', (e) => e.preventDefault()); // Safari: no page zoom

function setRay(e) {
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
}
// A llama's outline on screen. The camera looks down at ~30°, so a cursor up by the neck or
// head (or in the gaps between the legs) maps to a ground point far *behind* the llama, which
// would make it turn and walk away. So proximity is judged on screen instead:
//   inside the box        → it's a poke (gaps between the legs included)
//   inside box + margin   → "at the llama": keep the walk target, the llama looks at the viewer
function inRect(r, x, y, margin = 0) {
  return x > r.x0 - margin && x < r.x1 + margin && y > r.y0 - margin && y < r.y1 + margin;
}
function nearMargin(r) { return Math.max(40, (r.y1 - r.y0) * 0.2); }
// the llama under the pointer (the one nearest the camera if they overlap)
function llamaAt(x, y, withMargin) {
  let best = null, bestDepth = -Infinity;
  for (const l of llamas) {
    const r = l.screenRect();
    if (!inRect(r, x, y, withMargin ? nearMargin(r) : 0)) continue;
    const depth = l.group.position.dot(camDir);
    if (depth > bestDepth) { bestDepth = depth; best = l; }
  }
  return best;
}

let orbitDrag = null;          // { x, y }: a right-drag turning the camera (control panel section)
function onPointerMove(e) {
  if (FIXED_SPEED !== null || introOn || orbitDrag) return;   // intro: yours waits, unseen (right-dragging: orbiting, not leading)
  if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && touches.size >= 2) { setZoom(pinch.z * spread() / pinch.d); return; } // touch: pinch-zoom
  }
  if (pinch) return;
  if (e.target.closest?.('#panel, #panel-toggle')) { marker.visible = false; return; }
  if (Math.hypot(e.clientX - lastPX, e.clientY - lastPY) > 3) pointerIdle = 0;
  lastPX = e.clientX; lastPY = e.clientY;
  setRay(e);
  const near = llamaAt(e.clientX, e.clientY, true);
  for (const l of llamas) l.hovered = l === near;
  pointerOn = llamaAt(e.clientX, e.clientY, false);
  document.body.classList.toggle('over-llama', !!pointerOn || !!pieceAt());   // the hand cursor (style.css) — piles: fallen pieces too
  // pet: a gentle stroke over a llama (moving, not too fast, not pressing) soothes it
  // (touch: a finger rubbing it, which turns its press into a stroke rather than a hold)
  const now = performance.now(), stroke = Math.hypot(e.clientX - petX, e.clientY - petY), pace = stroke / Math.max(1, now - petAt);
  const stroking = !press || (press.claimed && e.pointerType !== 'mouse');
  if (pointerOn && stroking && pace > 0.02 && pace < 1.4) pointerOn.pet(stroke);
  petX = e.clientX; petY = e.clientY; petAt = now;
  // reaching for yours: keep the old target, so it doesn't turn and walk off. Over any other llama
  // the target still follows the pointer (yours walks up to it); only the marker hides.
  const keep = near === player;
  if (keep || pointerOn) marker.visible = false;
  const onRampHit = ramp && ray.intersectObject(ramp.group, true).find((h) => h.object.material.vertexColors);
  if (!keep && (onRampHit ? target.copy(onRampHit.point) : ray.ray.intersectPlane(ground, target))) {
    if (!hasTarget) {
      hasTarget = true;
      hint.style.opacity = 0;
      // once they've played a little, hint that the llamas can be poked
      setTimeout(() => { hint.textContent = 'poke the llama'; hint.style.opacity = 1; }, 9000);
      setTimeout(() => { hint.style.opacity = 0; }, 13000);
      setTimeout(() => { hint.textContent = TOUCH ? 'double-tap the ground to drop a ball' : 'click the ground to drop a ball'; hint.style.opacity = 1; }, 22000);
      setTimeout(() => { hint.style.opacity = 0; }, 26000);
      setTimeout(() => { hint.textContent = TOUCH ? 'rub a llama gently to pet it' : 'stroke a llama gently to pet it'; hint.style.opacity = 1; }, 48000);
      setTimeout(() => { hint.style.opacity = 0; }, 52500);
      if (ramp) setTimeout(() => { hint.textContent = 'walk your llama up the ramp'; hint.style.opacity = 1; }, 70000);
      setTimeout(() => { hint.style.opacity = 0; }, 74500);
    }
    marker.visible = !pointerOn;
    marker.position.set(target.x, groundHeight(target.x, target.z) + 0.05, target.z);
    marker.quaternion.setFromUnitVectors(_up, groundNormal(target.x, target.z, _n)).multiply(_flat); // ramp: lie on the slope
    target.y = 0;
  }
}
addEventListener('pointermove', onPointerMove);
document.addEventListener('pointerleave', (e) => {
  if (e.pointerType !== 'touch') marker.visible = false;  // (touch: a finger lifting keeps the spot it chose)
  pointerOn = null;
  for (const l of llamas) l.hovered = false;
});
const _drop = new THREE.Vector3();
// Pressing a llama: a quick tap pokes it; holding is a "press" other features can claim
// (gather the herd uses it to herd a llama). A press is cancelled if the pointer leaves it.
const TAP_MAX = 0.3;           // seconds: shorter than this counts as a tap
let press = null;              // { llama, t, x, y, claimed }
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (FIXED_SPEED !== null || introOn || e.button === 2) return;   // (intro: nothing to do in the scene yet; right button: orbiting)
  const touch = e.pointerType === 'touch';
  if (touch) {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2) { pinch = { d: Math.max(1, spread()), z: +zoomIn.value }; press = null; return; } // second finger: pinch
    if (touches.size > 2) return;
    petX = e.clientX; petY = e.clientY; petAt = performance.now();
    onPointerMove(e);              // a finger going down is where the "cursor" is now: aim there
  }
  setRay(e);
  const hit = llamaAt(e.clientX, e.clientY, false);
  const piece = !hit && pieceAt();                      // piles: a fallen piece
  if (hit) press = { llama: hit, t: 0, x: e.clientX, y: e.clientY, claimed: false };
  else if (piece) tapPiece(piece);
  else if (ray.ray.intersectPlane(ground, _drop) && !onRamp(_drop.x, _drop.z, 1)) { // ramp: no balls inside it
    const now = performance.now();
    // mouse: a click drops a ball; touch: a double-tap does (a single tap just walks there)
    if (!touch || (lastTap && now - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40)) {
      dropBall(_drop.x, _drop.z); pointerIdle = 0; lastTap = null;
    } else lastTap = { t: now, x: e.clientX, y: e.clientY };
  }
});
function pointerDone(e) {
  touches.delete(e.pointerId);
  if (touches.size < 2) pinch = null;
  if (e.type === 'pointerup' && press && !press.claimed && press.t < TAP_MAX) press.llama.poke();
  press = null;
}
addEventListener('pointerup', pointerDone);
addEventListener('pointercancel', pointerDone);
addEventListener('pointermove', (e) => {
  if (!press) return;
  const r = press.llama.screenRect();
  if (!inRect(r, e.clientX, e.clientY, nearMargin(r))) { press = null; return; } // slid off the llama: cancel
  // touch: a finger moving on it is a stroke (petting), not a hold — so it won't herd or poke
  if (e.pointerType !== 'mouse' && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) press.claimed = true;
});

// ---------- behaviour (shared) ----------
const LOOK_AFTER = 3;           // seconds of cursor stillness before it starts glancing around
const KUSH_AFTER = 27;          // ...and before it lies down
const DANCE_LEN = 2.7;
const DROP_H = 9, DROP_G = 100;  // intro: your llama's drop into the scene (height, gravity)
const SETTLE_HOLD = 2.6;        // intro: seconds after the drop that yours ignores the cursor (the landing, the look)...
const SETTLE_EASE = 3.5;        // ...then its top speed builds from a gentle walk to full over this long
const SETTLE_WALK = 2.5;        // (that walk)
// turning: well away from where it's going, it keeps walking as it turns (a tight arc, not a spin
// on the spot); close by, or held up, it turns where it stands, pivoting on its hind legs
const ARC_SPEED = 2.4;          // walking pace kept up through a turn
const ARC_FROM = 8;             // ...when the goal is at least this far away
const PIVOT_BACK = 1.4;         // turning on the spot: the point it turns about, this far behind its middle
const KEEL_SWAY = 2.4, KEEL_TIP = 0.55; // blight: seconds staggering before it goes, and of the fall itself
const KEEL_EDGE = 1.07;          // blight: the outer edge of its hooves (what it tips over on)
const KEEL_OVER = 0;            // blight: how far past its side it rolls (rad; more lifts the stiff legs)
const KEEL_BODY = 3.2;          // blight: how far to the side its body lies (from where it stood)
const KEEL_SIDE = 1;            // blight: which side it prefers to fall to (it's turned to face you first)
const _dimEye = new THREE.Color(0x262626), _hsl = {}; // blight: dark eyes on a paled coat
const seg = (x, a, b) => clamp((x - a) / (b - a), 0, 1);
// hop height over time: crouch, spring up, land, settle
function hopCurve(t) {
  if (t < 0.12) return -0.3 * smooth(0, 1, t / 0.12);
  if (t < 0.5) { const u = (t - 0.12) / 0.38; return -0.3 + 1.3 * 4 * u * (1 - u); } // airborne arc, peak +1.0
  if (t < 0.68) return -0.3 * (1 - smooth(0, 1, (t - 0.5) / 0.18));
  return 0;
}

// Pronking: three stiff-legged bounces, then a little wiggle.
const PRONK = 0.62;
function danceHop(t) { return t < PRONK * 3 ? hopCurve(t % PRONK) * 0.9 : 0; }

const _head = new THREE.Vector3();
function heart(head) {
  head.getWorldPosition(_head);
  _head.y += 1.2;
  const p = _head.project(camera);
  const el = document.createElement('div');
  el.className = 'heart';
  el.style.cssText = `left:${(p.x * 0.5 + 0.5) * innerWidth}px;top:${(-p.y * 0.5 + 0.5) * innerHeight}px;--dx:${(Math.random() - 0.5) * 70}px`;
  el.innerHTML = '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="#f07a76"><path d="M12 21s-7.5-4.6-9.6-9.3C.9 8.4 3 4.5 6.7 4.5c2.2 0 3.6 1.2 5.3 3.1 1.7-1.9 3.1-3.1 5.3-3.1 3.7 0 5.8 3.9 4.3 7.2C19.5 16.4 12 21 12 21z"/></svg>';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1400);
}


// ---------- balls ----------
// World objects any llama can claim. Clicking the floor drops one (touch: double-tap); a llama
// walks to the nearest unclaimed ball and kicks it.
const balls = [];
const MAX_BALLS = 6;
const BALL_R = 0.38;
const pelletGeo = new THREE.SphereGeometry(BALL_R, 16, 12);
const BALL_MAT = mat(C.nose);
function dropBall(x, z) {
  if (balls.length >= MAX_BALLS) return;
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  const pellet = new THREE.Mesh(pelletGeo, BALL_MAT);
  g.add(pellet);
  pellet.castShadow = true;
  scene.add(g);
  balls.push({ pos: g.position, g, pellet, t: 0, claimedBy: null });
}
function disposeBall(tr) {
  scene.remove(tr.g);
}
function removeBall(tr) {
  const i = balls.indexOf(tr);
  if (i >= 0) balls.splice(i, 1);
}
// drop with a bounce, squashing on impact; it rests as a perfect sphere
function updateBalls(dt) {
  for (const tr of balls) {
    const t0 = tr.t;
    tr.t += dt;
    const t = tr.t;
    if (t0 < 0.35 && t >= 0.35) sfx.tap(tr.pos);          // sfx: lands...
    if (t0 < 0.57 && t >= 0.57) sfx.tap(tr.pos, 0.35);    // ...and its little bounce
    let y = 0, squash = 1;
    if (t < 0.35) y = 3.2 * (1 - (t / 0.35) ** 2);
    else if (t < 0.57) { const u = (t - 0.35) / 0.22; y = 0.5 * 4 * u * (1 - u); }
    if (t > 0.33 && t < 0.47) squash = 1 - 0.3 * Math.sin(Math.PI * (t - 0.33) / 0.14);
    const w = 1 / Math.sqrt(squash);
    tr.pellet.scale.set(w, squash, w);
    tr.pellet.position.y = BALL_R * squash + y;
  }
  updateLoose(dt);
}

// Kicked balls fly, bounce and roll until they leave the screen.
// On the way they bounce off the ramp's walls (and can roll up its slope and drop off the far
// edge), glance off llamas (who hop in surprise), and roll through the paint, leaving a streak.
const loose = [];
const _ndc = new THREE.Vector3();
function kickBall(tr, dir, power, by = null) {
  removeBall(tr);
  loose.push({ tr, t: 0, y: BALL_R, vx: Math.cos(dir) * power, vz: -Math.sin(dir) * power, vy: 7, by });
}
// ramp: a ball running into a wall (anywhere the ramp stands higher than the ball's underside)
// bounces back off it; coming up the slope from its foot, it just rolls on up
function bounceOffRamp(b, pos, ox, oz) {
  if (!ramp) return;
  const hx = RAMP_LEN / 2 + BALL_R, hz = RAMP_W / 2 + BALL_R, x0 = -RAMP_LEN / 2;
  const [x, z] = rampLocal(pos.x, pos.z);
  if (Math.abs(x) >= hx || Math.abs(z) >= hz) return;
  const cx = clamp(x, x0, -x0), h = cx < x0 + RAMP_SLOPE ? ((cx - x0) / RAMP_SLOPE) * RAMP_H : RAMP_H;
  if (b.y - BALL_R > h - 0.25) return;                   // over it, or rolling up the slope
  const [px, pz] = rampLocal(ox, oz), c = Math.cos(ramp.rot), s = Math.sin(ramp.rot);
  let lvx = b.vx * c - b.vz * s, lvz = b.vx * s + b.vz * c, nx = x, nz = z;
  if (Math.abs(pz) >= hz - 0.01) { lvz = -lvz * 0.7; nz = Math.sign(pz) * hz; }          // a side wall
  else if (px >= hx - 0.01) { lvx = -lvx * 0.7; nx = hx; }                               // the back wall
  else if (hz - Math.abs(z) < hx - Math.abs(x)) { lvz = -lvz * 0.7; nz = Math.sign(z) * hz; }
  else { lvx = -lvx * 0.7; nx = Math.sign(x) * hx; }
  rampWorld(nx, nz, pos);
  b.vx = lvx * c + lvz * s; b.vz = -lvx * s + lvz * c;
  sfx.tap(pos, Math.min(1, Math.hypot(b.vx, b.vz) / 20));
}
// a ball rolling into a llama glances off its body (not the one that just kicked it); the llama
// jumps in surprise (see bonk)
function bounceOffLlamas(b, pos) {
  if (b.y > 6) return;                                   // sailing over their heads
  for (const l of llamas) {
    if (l === b.by && b.t < 0.4) continue;
    const g = l.group, c = Math.cos(g.rotation.y), s = Math.sin(g.rotation.y);
    const rx = pos.x - g.position.x, rz = pos.z - g.position.z;
    const along = clamp(rx * c - rz * s, -1.75, 1.7);     // nearest point on its spine (hips → shoulders)
    const qx = g.position.x + along * c, qz = g.position.z - along * s, R = 1.25 + BALL_R;
    let dx = pos.x - qx, dz = pos.z - qz;
    const d = Math.hypot(dx, dz);
    if (d >= R || d < 1e-6) continue;
    dx /= d; dz /= d;
    const vn = b.vx * dx + b.vz * dz;
    if (vn >= 0) continue;                               // already heading away
    b.vx -= 1.6 * vn * dx; b.vz -= 1.6 * vn * dz;        // bounce, losing a little
    pos.x = qx + dx * R; pos.z = qz + dz * R;
    sfx.tap(pos, Math.min(1, -vn / 20));
    l.bonk(pos);
  }
}
function updateLoose(dt) {
  for (let i = loose.length - 1; i >= 0; i--) {
    const b = loose[i], tr = b.tr;
    b.t += dt;
    const ox = tr.pos.x, oz = tr.pos.z;
    tr.pos.x += b.vx * dt;
    tr.pos.z += b.vz * dt;
    bounceOffRamp(b, tr.pos, ox, oz);
    bounceOffLlamas(b, tr.pos);
    const floor = groundHeight(tr.pos.x, tr.pos.z) + BALL_R;   // ramp: up the slope, onto the top
    b.vy -= 38 * dt;
    b.y += b.vy * dt;
    if (b.y <= floor) {
      b.y = floor;
      if (floor < BALL_R + 0.01) paintStreak(b, tr.pos);       // paint: on the ground, rolling
      if (b.vy < -2) {                                             // bounce, losing a little speed
        sfx.tap(tr.pos, Math.min(1, -b.vy / 14));                  // sfx:
        b.vy *= -0.5; b.vx *= 0.85; b.vz *= 0.85;
      } else {                                                       // rolling: gentle friction, but
        b.vy = 0;                                                  // never so slow it stays on screen
        const v = Math.hypot(b.vx, b.vz), k = Math.max(14, v * Math.exp(-0.5 * dt)) / v;
        b.vx *= k; b.vz *= k;
      }
    }
    tr.pellet.position.y = b.y;
    tr.pellet.scale.setScalar(1);
    _ndc.copy(tr.pos).project(camera);
    const done = Math.abs(_ndc.x) > 1.15 || Math.abs(_ndc.y) > 1.15 || b.t > 10;
    if (done) { disposeBall(tr); loose.splice(i, 1); }
  }
}
// Nearest ball this llama should go for. It skips balls claimed by someone else, and balls
// another llama is closer to (so two llamas never stand off around the same ball). Whoever is
// already chasing keeps a small head start, so a neck-and-neck race doesn't flip-flop.
const CHASE_HEAD_START = 1.5;
function nearestBall(who, x, z, current) {
  let best = null, bd = Infinity;
  for (const tr of balls) {
    if (tr.claimedBy && tr.claimedBy !== who) continue;
    const d = Math.hypot(tr.pos.x - x, tr.pos.z - z);
    const mine = d - (tr === current ? CHASE_HEAD_START : 0);
    const rival = llamas.some((l) => l.id !== who &&
      Math.hypot(tr.pos.x - l.group.position.x, tr.pos.z - l.group.position.z) < mine);
    if (!rival && d < bd) { bd = d; best = tr; }
  }
  return best;
}

// kicking: where the ball should be (ahead of the body centre) to kick it, and how long a kick lasts
const KICK_REACH = 2.95, KICK_LEN = 1.7;

// ---------- IK ----------
const knee = new THREE.Vector2();
function solveLeg(leg, hx, hy, fx, fy, k) {
  const { L1, L2 } = leg;
  leg.root.position.set(hx, hy, leg.hip.z);
  const dx = fx - hx, dy = fy - hy;
  const reach = Math.max(Math.hypot(dx, dy), 0.01), L = L1 + L2;
  // Soft IK: a hard clamp at full extension makes the knee angle change infinitely fast as the leg
  // straightens (the "snap"). Ease the solved reach toward L instead, and stretch the segments
  // a few percent so the foot still lands exactly on target.
  const d = reach > L - SOFT ? L - SOFT * Math.exp(-(reach - (L - SOFT)) / SOFT) : reach;
  const st = clamp(reach / d, 1, MAX_STRETCH);
  const a = Math.atan2(dy, dx);
  const alpha = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
  const ang = leg.front ? a + alpha : a - alpha; // front knees point forward, hocks point back
  const kx = L1 * Math.cos(ang), ky = L1 * Math.sin(ang);
  const low = Math.atan2(d * Math.sin(a) - ky, d * Math.cos(a) - kx);
  // Near full extension a tiny change in reach swings the joint a lot; a very short
  // smoothing on the joint angles (k = blend per frame) soaks up those pops.
  leg.angU = leg.angU === undefined ? ang : leg.angU + wrap(ang - leg.angU) * k;
  leg.angL = leg.angL === undefined ? low : leg.angL + wrap(low - leg.angL) * k;
  knee.set(st * L1 * Math.cos(leg.angU), st * L1 * Math.sin(leg.angU));
  leg.upper.rotation.z = leg.angU;
  leg.upper.scale.x = leg.lower.scale.x = st;
  leg.lower.position.set(knee.x, knee.y, 0);
  leg.lower.rotation.z = leg.angL;
}

const hermite = (p0, m0, p1, m1, t) => {
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * m1;
};
// 0 → 1 → 0 with zero slope at both ends and at the peak (tp)
const bump = (t, tp) => t < tp ? smooth(0, 1, t / tp) : smooth(0, 1, (1 - t) / (1 - tp));

// Foot path relative to its standing spot, for a foot at cycle point p.
// Stance: slides back at exactly body speed (so it reads as planted).
// Swing: leaves the ground still drifting back at stance speed and eases into the forward
// swing; arrives moving back at stance speed again, so touchdown matches the ground.
// Height eases up from and down to zero vertical speed, peaking early (tp).
// Writes into one reused object (no per-frame allocation): read .x/.y before calling again.
const _foot = { x: 0, y: 0 };
function footPath(p, duty, stride, lift, tp) {
  if (p < duty) { _foot.x = stride / 2 - stride * (p / duty); _foot.y = 0; return _foot; }
  const t = (p - duty) / (1 - duty);
  const m = -stride * (1 - duty) / duty * 0.6; // stance velocity in swing-time units (softened)
  _foot.x = hermite(-stride / 2, m, stride / 2, m, t);
  _foot.y = lift * bump(t, tp);
  return _foot;
}

// ---------- sound ----------
// Quiet, synthesized: the ball's taps and the kick's pock are foley (filtered noise and falling
// sines); everything else is soft chimes on one scale (C major pentatonic, so any order sounds
// sweet), and only for your llama. Its footsteps wander gently up and down the scale (and climb it
// as it climbs the ramp); hops, naps and herding get little tings and arpeggios. Panned by where
// it happens on screen. Browsers only allow audio after a click/tap/key, so it starts then.
// To remove: set SFX = false (or delete this section and the small hooks marked "sfx:").
const SFX = FIXED_SPEED === null;
const SFX_VOL = 0.4;       // master level
const CHIME_VOL = 0.06;    // the chimes (footsteps a little softer still)
let sfxOn = SFX, actx = null, sfxOut = null, sfxNoise = null;
function sfxStart() {
  if (!sfxOn) return;
  if (actx) { if (actx.state === 'suspended') actx.resume(); return; }
  actx = new AudioContext();
  sfxOut = actx.createGain();
  sfxOut.gain.value = introOn ? 0 : SFX_VOL;   // intro: the scene stays quiet until the snap
  sfxOut.connect(actx.destination);
  sfxNoise = actx.createBuffer(1, actx.sampleRate, actx.sampleRate); // a second of white noise, reused
  const d = sfxNoise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
}
if (SFX) for (const ev of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) addEventListener(ev, sfxStart); // (iOS wants a touch's end)
const _sp = new THREE.Vector3();
// level and pan for a sound at a world position (off screen: silent)
function sfxAt(pos) {
  if (!sfxOn || !actx || actx.state !== 'running') return null;
  _sp.copy(pos).project(camera);
  const v = 1 - smooth(0.9, 1.2, Math.max(Math.abs(_sp.x), Math.abs(_sp.y)));
  return v > 0.01 ? [v, clamp(_sp.x * 0.5, -0.6, 0.6)] : null;
}
function sfxEnv(node, t, gain, attack, decay, pan) {
  const g = actx.createGain(), pn = actx.createStereoPanner();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  pn.pan.value = pan;
  node.connect(g).connect(pn).connect(sfxOut);
}
// a burst of filtered noise
function sfxHiss(t, pan, { type = 'lowpass', freq, q = 0.7, gain, decay, attack = 0.004 }) {
  const src = actx.createBufferSource(), f = actx.createBiquadFilter();
  src.buffer = sfxNoise;
  f.type = type; f.frequency.value = freq; f.Q.value = q;
  sfxEnv(src.connect(f), t, gain, attack, decay, pan);
  src.start(t, Math.random() * 0.7);
  src.stop(t + attack + decay + 0.05);
}
// a short sine that falls in pitch (the body of a thump or knock)
function sfxTone(t, pan, { from, to, gain, decay }) {
  const o = actx.createOscillator();
  o.frequency.setValueAtTime(from, t);
  o.frequency.exponentialRampToValueAtTime(to, t + decay);
  sfxEnv(o, t, gain, 0.003, decay, pan);
  o.start(t);
  o.stop(t + decay + 0.05);
}
// Tunes to try (picked in the panel): a scale (semitones in one octave), the note degree 0 sits
// on, and a voice: partials as [frequency multiple, level, decay multiple, wave].
const TUNES = {
  chime:   { name: 'Chime · pentatonic', scale: [0, 2, 4, 7, 9], base: 523.25,     // C5, bright
             voice: [[1, 1, 1, 'sine'], [3, 0.12, 0.3, 'sine']] },
  marimba: { name: 'Marimba · pentatonic', scale: [0, 2, 4, 7, 9], base: 261.63,   // C4, warm and woody
             voice: [[1, 1, 1.3, 'sine'], [4, 0.2, 0.12, 'sine'], [10, 0.04, 0.04, 'sine']] },
  dreamy:  { name: 'Dreamy · lydian', scale: [0, 2, 4, 6, 7, 9, 11], base: 349.23, // F4, floaty
             voice: [[1, 1, 1.6, 'triangle'], [2, 0.15, 0.8, 'sine']] },
  mellow:  { name: 'Mellow · minor pentatonic', scale: [0, 3, 5, 7, 10], base: 293.66, // D4, soft
             voice: [[1, 1, 1.4, 'sine'], [2, 0.25, 0.6, 'sine']] },
  koto:    { name: 'Koto · in scale', scale: [0, 1, 5, 7, 8], base: 329.63,      // E4, plucked
             voice: [[1, 1, 1.2, 'triangle'], [2, 0.3, 0.3, 'sine'], [3, 0.1, 0.15, 'sine']] },
};
// a different one each visit (and each time round the loop) — or the one picked in the controls
const randomTune = () => { const all = Object.values(TUNES); return all[Math.floor(Math.random() * all.length)]; };
let tune = TUNES[saved('llama-tune')] ?? randomTune();
function noteHz(deg) {
  const n = tune.scale.length, oct = Math.floor(deg / n);
  return tune.base * 2 ** ((12 * oct + tune.scale[deg - oct * n]) / 12);
}
// one note in the current tune's voice
function sfxNote(t, pan, deg, gain, decay) {
  for (const [mul, level, dm, wave] of tune.voice) {
    const o = actx.createOscillator();
    o.type = wave;
    o.frequency.value = noteHz(deg) * mul;
    sfxEnv(o, t, gain * level, 0.004, decay * dm, pan);
    o.start(t);
    o.stop(t + decay * dm + 0.05);
  }
}
// a little run of chimes (degrees), `gap` seconds apart
function sfxNotes(pos, degs, { gap = 0.07, gain = CHIME_VOL, decay = 0.22 } = {}) {
  const at = sfxAt(pos); if (!at) return;
  const [v, pan] = at, t = actx.currentTime;
  degs.forEach((d, i) => sfxNote(t + i * gap, pan, d, gain * v, decay));
}
const sfx = {
  // a footstep: a soft, muted tap on one pitch (so it stays out of the music's way); a touch
  // higher and more knocky up on the ramp
  step(pos, height) {
    const at = sfxAt(pos); if (!at) return;
    const [v, pan] = at, t = actx.currentTime, r = 0.94 + Math.random() * 0.12;
    sfxTone(t, pan, { from: (height > 0.05 ? 300 : 230) * r, to: 140, gain: 0.03 * v, decay: 0.035 });
    sfxHiss(t, pan, { type: 'bandpass', freq: 1800 * r, q: 1.2, gain: 0.015 * v, decay: 0.015 });
  },
  hop: (pos) => sfxNotes(pos, [4, 7]),                                         // boop-bip, up
  boop: (pos) => sfxNotes(pos, [7, 9], { gap: 0.06, gain: CHIME_VOL * 0.7 }),  // poking another llama: bip-bip
  pronk: (pos, k) => sfxNotes(pos, [5 + 2 * k]),                               // dance: up a step each bounce
  lieDown: (pos) => sfxNotes(pos, [4, 2, 0], { gap: 0.2, decay: 0.4, gain: CHIME_VOL * 0.8 }), // sleepy, down
  getUp: (pos) => sfxNotes(pos, [0, 2, 4], { gap: 0.09 }),
  herdJoin: (pos, n) => sfxNotes(pos, [2 + n, 4 + n]),                         // higher with each one herded
  herdLost: (pos) => sfxNotes(pos, [6, 4, 2, 0], { gap: 0.13, decay: 0.35 }),  // time ran out: aww
  party: (pos) => sfxNotes(pos, [5, 7, 9, 10, 12], { gap: 0.08, decay: 0.3 }),
  // pet: a contented llama's hum — a soft low "mm", two sines a hair apart, rising a touch then settling
  hum(pos) {
    const at = sfxAt(pos); if (!at) return;
    const [v, pan] = at, t = actx.currentTime;
    let f = noteHz(pick([0, 2, 4]));
    while (f > 330) f /= 2;
    for (const det of [1, 1.004]) {
      const o = actx.createOscillator();
      o.frequency.setValueAtTime(f * 0.96 * det, t);
      o.frequency.linearRampToValueAtTime(f * det, t + 0.25);
      o.frequency.linearRampToValueAtTime(f * 0.97 * det, t + 1.1);
      sfxEnv(o, t, 0.045 * v, 0.25, 0.9, pan);
      o.start(t);
      o.stop(t + 1.25);
    }
  },
  // rain: shaking off — a quick wobbly trill that shakes itself out and lands on a bright note
  // (yours at full voice, the herd's softer, so a field of them shaking off cascades gently)
  shake(pos, mine) {
    const at = sfxAt(pos); if (!at) return;
    const [v, pan] = at, t = actx.currentTime, g = CHIME_VOL * v * (mine ? 1 : 0.5);
    [7, 8, 7, 8, 7, 8, 7].forEach((d, i) => sfxNote(t + i * 0.045, pan, d, g * (1 - i * 0.08), 0.1));
    sfxNote(t + 0.38, pan, 12, g, 0.5);
  },
  // piles: a piece landing or bumping — a soft wooden tok (blocks), a duller thud (balls), a tick (cone, stick)
  // blight: a llama keeling over — a soft, dull thud, and the breath going out of it
  keel(pos) {
    const at = sfxAt(pos); if (!at) return;
    const [v, pan] = at, t = actx.currentTime;
    sfxTone(t, pan, { from: 120, to: 45, gain: 0.22 * v, decay: 0.25 });
    sfxHiss(t, pan, { freq: 500, gain: 0.08 * v, decay: 0.12 });
    sfxHiss(t + 0.15, pan, { freq: 900, gain: 0.015 * v, attack: 0.2, decay: 0.6 });
  },
  // void: something sinking into it — a low, soft swallow
  gulp(pos) {
    const at = sfxAt(pos); if (!at) return;
    const [v, pan] = at, t = actx.currentTime;
    sfxTone(t, pan, { from: 70, to: 28, gain: 0.18 * v, decay: 0.7 });
  },
  // intro: your llama hitting the ground after the snap — a heavy, dull thud
  land(pos) {
    const at = sfxAt(pos); if (!at) return;
    const [v, pan] = at, t = actx.currentTime;
    sfxTone(t, pan, { from: 150, to: 45, gain: 0.5 * v, decay: 0.2 });
    sfxHiss(t, pan, { freq: 700, gain: 0.2 * v, decay: 0.07 });
  },
  // piles: a piece popped by a click — a soft rising bloop
  pop(pos) {
    const at = sfxAt(pos); if (!at) return;
    const [v, pan] = at, t = actx.currentTime;
    sfxTone(t, pan, { from: 260, to: 560, gain: 0.07 * v, decay: 0.09 });
    sfxHiss(t, pan, { type: 'bandpass', freq: 1400, q: 2, gain: 0.02 * v, decay: 0.03 });
  },
  knock(pos, kind, k) {
    const at = sfxAt(pos); if (!at) return;
    const [v, pan] = at, t = actx.currentTime, r = 0.9 + Math.random() * 0.2;
    const f = (kind === 'box' ? 420 : kind === 'ball' ? 210 : 650) * r;
    sfxTone(t, pan, { from: f, to: f * 0.6, gain: 0.07 * v * k, decay: kind === 'ball' ? 0.08 : 0.05 });
    sfxHiss(t, pan, { type: 'bandpass', freq: f * 3, q: 4, gain: 0.03 * v * k, decay: 0.03 });
  },
  // poked into a happy dance: a bouncy jingle on its three pronks (0.12, 0.74, 1.36)
  dance(pos) {
    const at = sfxAt(pos); if (!at) return;
    const [v, pan] = at, t = actx.currentTime;
    const song = [[2, 0.12], [4, 0.2], [7, 0.74], [5, 0.82], [9, 1.36], [7, 1.44], [12, 1.95]];
    song.forEach(([d, dt], i) => sfxNote(t + dt, pan, d, CHIME_VOL * v, i === song.length - 1 ? 0.6 : 0.22));
  },
  // ramp: top reached — a little jingle, its notes landing on the dance's bounces (0.12, 0.74, 1.36)
  summit(pos) {
    const at = sfxAt(pos); if (!at) return;
    const [v, pan] = at, t = actx.currentTime;
    const song = [[0, 0], [2, 0.12], [4, 0.24], [7, 0.36], [4, 0.62], [7, 0.74], [9, 0.86],
                  [7, 1.24], [9, 1.36], [11, 1.48], [14, 1.86]];
    song.forEach(([d, dt], i) => sfxNote(t + dt, pan, d, CHIME_VOL * v, i === song.length - 1 ? 0.7 : 0.22));
  },
  // ramp: the summit glitch — a short, low digital chirp, jumping pitch halfway
  glitch(pos) {
    const at = sfxAt(pos); if (!at) return;
    const [v, pan] = at, t = actx.currentTime, f = 180 + Math.random() * 700, o = actx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(f, t);
    o.frequency.setValueAtTime(f * (0.5 + Math.random()), t + 0.02);
    sfxEnv(o, t, GLITCH_VOL * v, 0.001, 0.045, pan);
    o.start(t); o.stop(t + 0.08);
  },
  // the ball pellet touching down (k: how hard)
  tap(pos, k = 1) {
    const at = sfxAt(pos); if (!at) return;
    const [v, pan] = at, t = actx.currentTime;
    sfxHiss(t, pan, { type: 'bandpass', freq: 1000, q: 2, gain: 0.12 * v * k, decay: 0.03 });
    sfxTone(t, pan, { from: 380, to: 260, gain: 0.07 * v * k, decay: 0.04 });
  },
  // hoof meets ball
  kick(pos) {
    const at = sfxAt(pos); if (!at) return;
    const [v, pan] = at, t = actx.currentTime;
    sfxTone(t, pan, { from: 230, to: 90, gain: 0.28 * v, decay: 0.09 });
    sfxHiss(t, pan, { freq: 1400, gain: 0.14 * v, decay: 0.03 });
  },
};

// sfx: until the first click/tap/key there can be no sound, so a little "poke me" bubble floats
// over your llama (poking it is that first click). Gone for good after any click or key.
const pokeTip = document.getElementById('poke-tip');
let pokeWait = SFX ? 2.5 : -1;          // seconds before it shows (-1: never / done)
const _pt = new THREE.Vector3();
if (SFX) for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, () => { pokeWait = -1; pokeTip.classList.remove('show'); });
else pokeTip.remove();
function updatePokeTip(dt) {
  if (pokeWait < 0 || introOn) return;                  // poked: gone (intro: not while your llama is still to come)
  if ((pokeWait = Math.max(0, pokeWait - dt)) > 0) return; // shown: follows your llama every frame
  player.head.getWorldPosition(_pt);
  _pt.y += 2.6;
  _pt.project(camera);
  if (!Number.isFinite(_pt.x) || !innerWidth) return;   // no view yet (e.g. opened in a hidden tab)
  pokeTip.style.translate = `calc(${(_pt.x * 0.5 + 0.5) * innerWidth}px - 50%) calc(${(-_pt.y * 0.5 + 0.5) * innerHeight}px - 100%)`;
  pokeTip.classList.add('show');
}

// ---------- music ----------
// A quiet tune that makes itself up as it goes, in the current scale: a soft melody wandering by
// small steps, with unhurried, uneven timing and the odd rest, over a low note every few bars.
// Plays once sound has started; "Music" in the panel turns it off.
// blight: as the herd sickens the tune rots — rests creep in, it slows, it goes flat and out of
// tune, drifts downward and gets muffled, and the low notes give way to the intro's drone, until
// the drone is all that's left.
// To remove: set MUSIC = false (or delete this section and the hooks marked "music:").
const MUSIC = SFX;
const MUSIC_VOL = 0.025;
const MUSIC_DRONE = 0.05;     // blight: the drone's level once the tune has rotted away
let musicOn = MUSIC, musicOut = null, musicLP = null, drone = null;
let blight = 0;                // blight: how far it has spread, 0..1 (kept up by that section; music, rain read it)
let voidOpen = false;          // void: the pit is open (set in that section; read by sections before it)
let blightGlitch = 0;          // blight: your llama glitching now and then (0 or a burst's strength; drawGlitch reads it)
if (saved('llama-music') === 'off') musicOn = false;
const music = { wait: 1.5, deg: 3, n: 0 };
// the music's own output: a level (for fades) and a low-pass (blight: muffles it as it rots)
function musicBus() {
  if (!musicOut) {
    musicOut = actx.createGain(); musicLP = actx.createBiquadFilter();
    musicLP.type = 'lowpass'; musicLP.frequency.value = 12000;
    musicOut.connect(musicLP).connect(sfxOut);
  }
  return musicOut;
}
// a note with a softer attack than the chimes (and an octave down for the high tunes); cents: off-key
function musicNote(t, deg, gain, decay, cents = 0) {
  musicBus();
  const hz = noteHz(deg) * (tune.base > 400 ? 0.5 : 1);
  for (const [mul, level, dm, wave] of tune.voice) {
    const o = actx.createOscillator(), g = actx.createGain(), d = decay * dm;
    o.type = wave;
    o.frequency.value = hz * mul;
    o.detune.value = cents;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain * level, t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06 + d);
    o.connect(g).connect(musicOut);
    o.start(t);
    o.stop(t + 0.1 + d);
  }
}
const pick = (a) => a[Math.floor(Math.random() * a.length)];
function updateMusic(dt) {
  if (introOn || !actx || actx.state !== 'running') return;     // intro: not yet
  const rot = blight;                                            // blight: 0 sweet … 1 rotted away
  updateDrone(rot);
  if (!musicOn || !sfxOn || (music.wait -= dt) > 0) return;
  const t = actx.currentTime + 0.05, n = tune.scale.length;
  musicBus();
  musicLP.frequency.setTargetAtTime(700 + 11000 * (1 - rot) ** 3, t, 2);   // blight: muffled
  const off = () => -rot * 70 + (Math.random() - 0.5) * rot * 90;          // blight: flat, and unsteady
  if (music.n % 8 === 0 && rot < 0.85)                           // low note
    musicNote(t, [0, 3, 1, 4][(music.n / 8) % 4] - n, MUSIC_VOL * 0.9 * (1 - rot), 4, off());
  if (Math.random() < 0.82 * (1 - rot) ** 1.5) {                 // melody (sometimes a rest — blight: more and more)
    music.deg += pick([-2, -1, -1, 0, 1, 1, 2]) + (music.deg < 2 ? 1 : music.deg > 7 ? -1 : 0)
      - (Math.random() < rot * 0.35 ? 1 : 0);                      // blight: sinking
    music.deg = clamp(music.deg, 0, 9);
    musicNote(t, music.deg, MUSIC_VOL, 1.6 * (1 + rot), off());
  }
  music.n++;
  music.wait = pick([0.7, 0.7, 1.05, 1.05, 1.4, 2.1]) * (1 + 1.3 * rot);   // blight: slowing
}
// blight: the drone — the intro's (two low saws beating a semitone apart, a tritone above), low and
// muffled, breathing slowly; it rises as the tune rots. Through the music bus, so "Music" mutes it.
function updateDrone(rot) {
  const want = musicOn && sfxOn ? MUSIC_DRONE * smooth(0.35, 1, rot) : 0;
  if (!drone && want <= 0) return;
  const t = actx.currentTime;
  if (!drone) {
    const g = actx.createGain(), lp = actx.createBiquadFilter(), lfo = actx.createOscillator(), depth = actx.createGain();
    g.gain.value = 0;
    lp.type = 'lowpass'; lp.frequency.value = 260; lp.Q.value = 3;
    lfo.frequency.value = 0.07; depth.gain.value = 120;            // the filter slowly opening and closing
    lfo.connect(depth).connect(lp.frequency);
    lp.connect(g).connect(musicBus());
    const oscs = [[55, 'sawtooth', 1], [55.8, 'sawtooth', 1], [77.8, 'square', 0.35]].map(([hz, wave, level]) => {
      const o = actx.createOscillator(), og = actx.createGain();
      o.type = wave; o.frequency.value = hz; og.gain.value = level;
      o.connect(og).connect(lp);
      o.start(t);
      return o;
    });
    lfo.start(t);
    drone = { g, oscs: [...oscs, lfo] };
  }
  drone.g.gain.setTargetAtTime(want, t, 2);
  if (want <= 0 && drone.g.gain.value < 0.0005) {               // faded out: stop it
    for (const o of drone.oscs) o.stop(t + 0.1);
    drone = null;
  }
}

// ---------- intro (title screen) ----------
// A black card with "Llama Land" cut out of it (the scene already playing behind the type), and
// your llama nowhere to be seen. Play turns the sound on: the title swells for a second over a low
// drone, then a snap — the card is simply gone and your llama is simply there. Then the music
// fades in. Until the snap the scene's own sounds and music are held back.
// To turn off: INTRO_ON = false. To remove: delete this section, #intro in index.html + style.css, and the
// small hooks marked "intro:".
const BLIGHT_ON = !(params.has('calm') || ['off', 'false'].includes(params.get('blight'))); // ← false: no infection at all (the calm version, with the cute title) — ?calm in the address too
const INTRO_ON = true;        // ← false: skip the title screen and start straight in the scene
const INTRO_RAIN = false;      // ← false: no shower over the title screen
const INTRO = INTRO_ON && SFX; // (never in review mode)
// the calm version (no blight — switched off here, or in the panel last time): a cute title instead.
// The coral logo sits over the live scene with a Play button; no drone, no swell — just the snap and the drop.
const INTRO_CUTE = INTRO && (!BLIGHT_ON || saved('llama-blight') === 'off');
const CUTE_SNAP = 0.12;       // seconds from Play to the snap
const INTRO_SPIN = 4;         // degrees a second the camera slowly orbits while the cute title waits...
const ORBIT_HOME = camOrbit;  // ...and from Play it glides back to where it started (the angle the ramp was placed for)
const ORBIT_HOME_TIME = 1.2;  // seconds that glide takes at the least (eased in and out, the short way round)...
const ORBIT_HOME_SPEED = 90;  // ...longer for a long way round: it never turns faster than this (degrees a second)
let homing = null;            // { from, by, t }: the glide home in progress
const INTRO_SWELL = 2.5;        // seconds the title swells before the snap
const LOGO_START = 0.6;         // the title's size at first (× its width in style.css, --logo-w)
const LOGO_END = 1;         // ...and at the moment of the snap
const INTRO_MUSIC_IN = 1.6;   // seconds after the snap before the music starts fading in
const INTRO_RAIN_CLEAR = 1;   // ...and before the shower starts clearing (gone ~6 s later)
const INTRO_SHOWER = 1e6;     // (rain: the intro shower's length until the snap gives it an end)
const DRONE_VOL = 0.03;       // the drone's level under the swell
const SNAP_VOL = 0.05;        // the snap's level
const introEl = document.getElementById('intro');
let introOn = INTRO, introGo = false;
let introLayer = null;         // butterflies: { draw, end } — one drawn above the card (set in that section)
if (!INTRO) introEl.remove();
else {
  introEl.style.setProperty('--swell', LOGO_START);
  if (INTRO_CUTE) {
    introEl.classList.add('cute');
    // the logo inline (not an <img>), so each letter can pop in on its own, one after another
    const logo = document.createElement('div');
    logo.className = 'logo';
    logo.setAttribute('role', 'img'); logo.setAttribute('aria-label', 'llama land');
    introEl.prepend(logo);
    fetch('logo-cute.svg').then((r) => r.text()).then((svg) => {
      logo.innerHTML = svg;
      logo.querySelectorAll('path').forEach((p, i) => p.style.setProperty('--i', i));
    }).catch(() => { logo.innerHTML = '<img src="logo-cute.svg" alt="">'; });
    document.getElementById('play').innerHTML = 'Play';
  }
  hint.style.opacity = 0;                              // (hints wait for the scene)
  document.getElementById('play').addEventListener('click', introPlay);
  addEventListener('keydown', (e) => { if (introOn && (e.key === 'Enter' || e.key === ' ')) introPlay(); });
}
function introPlay() {
  if (introGo) return;
  introGo = true;
  if (INTRO_SPIN && INTRO_CUTE) {                      // the slow turn glides home (smoother's top speed is 1.875× the average)
    const by = ((ORBIT_HOME - camOrbit) % 360 + 540) % 360 - 180;
    homing = { from: camOrbit, by, t: 0, len: Math.max(ORBIT_HOME_TIME, 1.875 * Math.abs(by) / ORBIT_HOME_SPEED) };
  }
  sfxStart();
  introEl.classList.add('go');
  const lag = actx ? 0.03 + (actx.outputLatency || actx.baseLatency || 0) : 0; // so the picture lands with the sound
  if (INTRO_CUTE) {                                    // the cute title: just the snap, and it's gone
    if (actx) introSnapSound(actx.currentTime + 0.03 + CUTE_SNAP);
    setTimeout(introSnap, (lag + CUTE_SNAP) * 1000);
    return;
  }
  if (actx) introSound(actx.currentTime + 0.03);
  const t0 = performance.now() + lag * 1000;
  const frame = (now) => {
    const k = clamp((now - t0) / 1000 / INTRO_SWELL, 0, 1);
    if (k >= 1) return introSnap();
    introEl.style.setProperty('--swell', lerp(LOGO_START, LOGO_END, k * k));  // slow, then faster
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
function introSnap() {
  introEl.remove();
  introOn = false;            // your llama is drawn again from this frame (drawHerd)...
  introLayer?.end(); introLayer = null;   // butterflies: back down into the scene
  player.drop();              // ...in mid-air, falling
  if (!hasTarget) hint.style.opacity = 1;                 // (the first hint)
  if (rain && rainLen === INTRO_SHOWER) rainLen = rainT + INTRO_RAIN_CLEAR + 6;   // rain: the intro shower clears
  if (!actx) return;
  const t = actx.currentTime;
  sfxOut.gain.setValueAtTime(SFX_VOL, t);
  musicBus();
  musicOut.gain.setValueAtTime(0, t);
  musicOut.gain.setValueAtTime(0, t + INTRO_MUSIC_IN);
  musicOut.gain.linearRampToValueAtTime(1, t + INTRO_MUSIC_IN + 4);   // music: fades in, after the fall
  Object.assign(music, { wait: INTRO_MUSIC_IN, n: 0 });
}
// the drone (beating low saws a tritone apart, rising a little as a filter opens), cut dead by the
// snap (a bright crack of noise, a click and a low thump). Straight to the speakers, not via sfxOut.
function introSound(t) {
  const snap = t + INTRO_SWELL, out = actx.createGain();
  out.gain.value = DRONE_VOL;
  out.connect(actx.destination);
  const lp = actx.createBiquadFilter(), drone = actx.createGain();
  lp.type = 'lowpass'; lp.Q.value = 5;
  lp.frequency.setValueAtTime(120, t);
  lp.frequency.exponentialRampToValueAtTime(1800, snap);
  drone.gain.setValueAtTime(0, t);
  drone.gain.linearRampToValueAtTime(0.12, t + 0.15);
  drone.gain.exponentialRampToValueAtTime(0.4, snap);
  drone.gain.setValueAtTime(0, snap);
  lp.connect(drone).connect(out);
  for (const [hz, wave, level] of [[55, 'sawtooth', 1], [55.8, 'sawtooth', 1], [77.8, 'square', 0.5], [110, 'sine', 0.8]]) {
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = wave;
    o.frequency.setValueAtTime(hz, t);
    o.frequency.exponentialRampToValueAtTime(hz * 1.06, snap);
    g.gain.value = level;
    o.connect(g).connect(lp);
    o.start(t); o.stop(snap + 0.05);
  }
  const rumble = actx.createBufferSource(), bp = actx.createBiquadFilter(), rg = actx.createGain();
  rumble.buffer = sfxNoise; rumble.loop = true;
  bp.type = 'bandpass'; bp.Q.value = 1.5;
  bp.frequency.setValueAtTime(250, t);
  bp.frequency.exponentialRampToValueAtTime(900, snap);
  rg.gain.setValueAtTime(0, t);
  rg.gain.linearRampToValueAtTime(0.25, snap);
  rg.gain.setValueAtTime(0, snap);
  rumble.connect(bp).connect(rg).connect(out);
  rumble.start(t); rumble.stop(snap + 0.05);
  introSnapSound(snap);
}
// a finger snap: a sharp, bright crack of noise with a little woody pop and the soft knock of the
// finger landing on the palm, then a room and a couple of fading echoes
function introSnapSound(t) {
  const out = actx.createGain(), limit = actx.createDynamicsCompressor(); // (the limiter keeps it from clipping)
  out.gain.value = SNAP_VOL;
  limit.threshold.value = -6; limit.ratio.value = 12; limit.attack.value = 0.001;
  out.connect(limit).connect(actx.destination);
  const echo = actx.createDelay(1), fb = actx.createGain(), dark = actx.createBiquadFilter(), wet = actx.createGain();
  echo.delayTime.value = 0.19; fb.gain.value = 0.38;               // echoes: each one quieter and duller
  dark.type = 'lowpass'; dark.frequency.value = 2600;
  wet.gain.value = 0.5;
  echo.connect(dark).connect(fb).connect(echo);
  dark.connect(wet).connect(out);
  const room = actx.createConvolver(), roomWet = actx.createGain(); // a short, dark room tail
  const n = Math.floor(actx.sampleRate * 1.4), ir = actx.createBuffer(2, n, actx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    for (let i = 0, y = 0; i < n; i++) { y += 0.3 * (Math.random() * 2 - 1 - y); d[i] = y * Math.pow(1 - i / n, 4); }
  }
  room.buffer = ir; roomWet.gain.value = 0.9;
  room.connect(roomWet).connect(out);
  const snap = actx.createGain();                                   // dry + both sends
  snap.connect(out); snap.connect(echo); snap.connect(room);
  for (const [freq, q, gain, decay] of [[2600, 1.1, 2.4, 0.045], [6000, 0.7, 0.9, 0.012]]) { // crack, its sizzle
    const src = actx.createBufferSource(), f = actx.createBiquadFilter(), g = actx.createGain();
    src.buffer = sfxNoise;
    f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.0008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    src.connect(f).connect(g).connect(snap);
    src.start(t, Math.random() * 0.5); src.stop(t + decay + 0.02);
  }
  for (const [from, to, gain, decay] of [[1500, 950, 0.3, 0.025], [240, 110, 0.35, 0.05]]) { // pop, palm
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(to, t + decay);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    o.connect(g).connect(snap);
    o.start(t); o.stop(t + decay + 0.02);
  }
}

// ---------- right of way ----------
// Is a wanderer at `pos` in the way of your llama (in a corridor ahead of it, toward where it's
// heading next)? If so, put a spot just off that corridor, on the side it's already on, in `out`.
// Without this, llamas standing or napping in a cluster (say round the ramp) can box yours in.
const WAY_LOOK = 14, WAY_WIDTH = 7, ASIDE = 8;   // (wide: a llama alongside can box it in too)
const _wy = new THREE.Vector3();
function stepAside(pos, out) {
  const me = player.group.position, dest = player.dest;
  if (!dest || Math.hypot(dest.x - me.x, dest.z - me.z) < STOP_DIST + 1) return false;
  if (Math.hypot(pos.x - dest.x, pos.z - dest.z) < CONTACT + 3) return false; // it's what yours is walking up to
  _wy.copy(player.climbs ? climbRoute(me, dest) : dest);  // ramp: its next waypoint
  let dx = _wy.x - me.x, dz = _wy.z - me.z;
  const len = Math.hypot(dx, dz);
  if (len < 0.5) return false;
  dx /= len; dz /= len;
  const rx = pos.x - me.x, rz = pos.z - me.z, along = rx * dx + rz * dz, across = rx * dz - rz * dx;
  if (along < -3 || along > Math.min(WAY_LOOK, Math.hypot(dest.x - me.x, dest.z - me.z) + 2) || Math.abs(across) > WAY_WIDTH) return false;
  const side = across >= 0 ? 1 : -1;
  out.set(pos.x + dz * side * ASIDE, 0, pos.z - dx * side * ASIDE);
  if (onRamp(out.x, out.z, 2)) {                       // ramp: never onto it; straight away from yours instead
    const r = Math.hypot(rx, rz) || 1;
    out.set(pos.x + (rx / r) * ASIDE, 0, pos.z + (rz / r) * ASIDE);
    if (onRamp(out.x, out.z, 2)) return false;         // (wedged against it: leave it be)
  }
  return true;
}

// ---------- llamas ----------
// Each llama is self-contained: its own meshes, state, behaviour and leg rig. What drives it
// comes from its brain: 'cursor' follows the pointer, 'wander' strolls around on its own.
const STOP_DIST = 3.0, MAX_SPEED = 15, ACCEL = 9, DECEL = 7;
// the ears flop a beat behind each step of the walk and pace
const EAR_FLOP = 0.1;
// Avoidance: a moving llama looks ahead along its heading; another llama inside that corridor
// makes it curve away (more strongly the closer and more central it is) and ease off. Right in
// front, it stops and turns aside. Head-on pairs both veer to their own side and pass. No pushing.
const AVOID_LOOK = 13;   // how far ahead it looks
const AVOID_WIDTH = 4.5; // half-width of the corridor it needs clear
const CONTACT = 6.2;     // centre distance treated as "touching" (about a body length)
const GREET_DIST = 7.6;  // greet: where they stop walking in (they drift on a touch, to noses touching at ~7.3)
// wanderers pick destinations at least this far from other llamas and their destinations
const DEST_CLEAR = 8;
const _wp = new THREE.Vector3(), _wn = new THREE.Vector2();
// a random spot on the visible ground (kept away from the screen edges), at least minDist from `from`
function randomGroundPoint(out, from, minDist) {
  for (let i = 0; i < 20; i++) {
    _wn.set(lerp(-0.75, 0.75, Math.random()), lerp(-0.75, 0.45, Math.random()));
    ray.setFromCamera(_wn, camera);
    if (ray.ray.intersectPlane(ground, _wp) && Number.isFinite(_wp.x) &&
        Math.hypot(_wp.x - from.x, _wp.z - from.z) >= minDist) return out.set(_wp.x, 0, _wp.z);
  }
  // no usable view yet (e.g. a page loaded in a hidden tab reports a 0×0 window): scatter nearby
  const a = Math.random() * Math.PI * 2, r = minDist + 6 + Math.random() * 18;
  return out.set(from.x + Math.cos(a) * r, 0, from.z + Math.sin(a) * r);
}

// ---------- ramp (decoration) ----------
// One big wedge, placed fresh on every visit: a slope up to a flat top with a fluttering flag.
// Each face is a flat palette colour (that's all the "lighting" there is). Llamas walk around it.
// To remove: set RAMP = false (or delete this section and the small hooks marked "ramp:").
const RAMP = FIXED_SPEED === null;
const RAMP_SLOPE = 22, RAMP_TOP = 7, RAMP_H = 10, RAMP_W = 11; // slope run (~24°), flat top, height, width
const RAMP_LEN = RAMP_SLOPE + RAMP_TOP;
const RAMP_COLS = { slope: 0xf0a29e, top: 0xc3c8aa, side: 0xf6d2b2, back: 0xeac3a2 };
const FLAG = { len: 3.4, h: 2, pole: 5.5 };
const WIND = 0.6;          // world direction the flag streams toward (radians)
let ramp = null;           // { group, x, z, rot, flag, flagBase }

function rampGeometry() {
  const x0 = -RAMP_LEN / 2, xs = x0 + RAMP_SLOPE, x1 = x0 + RAMP_LEN, w = RAMP_W / 2, H = RAMP_H;
  const pos = [], col = [], c = new THREE.Color();
  const tri = (a, b, d, hex) => { pos.push(...a, ...b, ...d); c.set(hex); for (let k = 0; k < 3; k++) col.push(c.r, c.g, c.b); };
  const quad = (a, b, d, e, hex) => { tri(a, b, d, hex); tri(a, d, e, hex); };
  quad([x0, 0, -w], [x0, 0, w], [xs, H, w], [xs, H, -w], RAMP_COLS.slope);   // the slope
  quad([xs, H, -w], [xs, H, w], [x1, H, w], [x1, H, -w], RAMP_COLS.top);     // flat top
  quad([x1, H, -w], [x1, H, w], [x1, 0, w], [x1, 0, -w], RAMP_COLS.back);    // back wall
  quad([x0, 0, w], [x0, 0, -w], [x1, 0, -w], [x1, 0, w], RAMP_COLS.back);    // underside (void: seen as it tips into the pit)
  for (const z of [-w, w]) {                                                  // the two sides
    tri([x0, 0, z], [x1, 0, z], [x1, H, z], RAMP_COLS.side);
    tri([x0, 0, z], [x1, H, z], [xs, H, z], RAMP_COLS.side);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}
function flagGeometry() {
  // a swallowtail pennant, with points along both long edges so it can ripple
  const { len, h } = FLAG, n = 10, pts = [];
  for (let i = 0; i <= n; i++) pts.push(new THREE.Vector2((len * i) / n, h));
  pts.push(new THREE.Vector2(len * 0.72, h / 2));
  for (let i = n; i >= 0; i--) pts.push(new THREE.Vector2((len * i) / n, 0));
  return new THREE.ShapeGeometry(new THREE.Shape(pts));
}
// Still random, but never awkward: the whole thing (flag included) sits well inside the view,
// there's room on screen to walk up to its foot, and the slope isn't pointing away from you.
function rampFits(x, z, rot) {
  const c = Math.cos(rot), s = Math.sin(rot), v = new THREE.Vector3(), pts = [[-RAMP_LEN / 2 - 8, 0, 0]];
  for (const lx of [-RAMP_LEN / 2, RAMP_LEN / 2]) for (const lz of [-RAMP_W / 2, RAMP_W / 2])
    for (const y of [0, RAMP_H + FLAG.pole]) pts.push([lx, y, lz]);
  for (const [lx, y, lz] of pts) {
    v.set(x + lx * c + lz * s, y, z - lx * s + lz * c).project(camera);
    if (!(Math.abs(v.x) < 0.85 && Math.abs(v.y) < 0.85)) return false;
  }
  return (-c * camDir.x + s * camDir.z) / Math.hypot(camDir.x, camDir.z) > -0.25; // downhill · toward camera
}
if (RAMP) {
  const p = new THREE.Vector3();
  let rot = 0;
  for (let i = 0; i < 300; i++) {
    randomGroundPoint(p, { x: 0, z: 0 }, 20);
    rot = Math.random() * Math.PI * 2;
    if (rampFits(p.x, p.z, rot)) break;
  }
  const group = new THREE.Group();
  group.position.set(p.x, 0, p.z);
  group.rotation.y = rot;
  const body = new THREE.Mesh(rampGeometry(), new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  body.castShadow = true;
  const poleX = RAMP_LEN / 2 - 1.2, poleZ = -RAMP_W / 2 + 1.2;   // back corner, out of the way
  const pole = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, FLAG.pole, 3, 8), mat(0xd6d6d6));
  pole.position.set(poleX, RAMP_H + FLAG.pole / 2 + 0.16, poleZ);
  pole.castShadow = true;
  const flagGeo = flagGeometry();
  const flag = new THREE.Mesh(flagGeo, new THREE.MeshBasicMaterial({ color: 0xf08b86, side: THREE.DoubleSide }));
  flag.position.set(poleX, RAMP_H + FLAG.pole - FLAG.h + 0.1, poleZ);
  flag.rotation.y = WIND - rot;          // stream with the world's wind, whatever the ramp's angle
  flag.castShadow = true;
  // the walkable surface (slope + top) also catches shadows, e.g. yours as you climb
  const x0 = -RAMP_LEN / 2, xs = x0 + RAMP_SLOPE, x1 = RAMP_LEN / 2, w = RAMP_W / 2, lift = 0.03;
  const surf = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([
    x0, lift, -w, x0, lift, w, xs, RAMP_H + lift, w,  x0, lift, -w, xs, RAMP_H + lift, w, xs, RAMP_H + lift, -w,
    xs, RAMP_H + lift, -w, xs, RAMP_H + lift, w, x1, RAMP_H + lift, w,  xs, RAMP_H + lift, -w, x1, RAMP_H + lift, w, x1, RAMP_H + lift, -w,
  ], 3));
  const catcher = new THREE.Mesh(surf, new THREE.ShadowMaterial({ opacity: 0.07, side: THREE.DoubleSide }));
  catcher.receiveShadow = true;
  group.add(body, pole, flag, catcher);
  scene.add(group);
  ramp = { group, x: p.x, z: p.z, rot, flag, flagBase: flagGeo.attributes.position.array.slice(), t: 0 };
}
// is (x, z) on the ramp's footprint (plus a margin)?
function onRamp(x, z, margin = 0) {
  if (!ramp) return false;
  const dx = x - ramp.x, dz = z - ramp.z, c = Math.cos(ramp.rot), s = Math.sin(ramp.rot);
  return Math.abs(dx * c - dz * s) < RAMP_LEN / 2 + margin && Math.abs(dx * s + dz * c) < RAMP_W / 2 + margin;
}
// Getting around it: a static obstacle is planned around, not reacted to. If the straight line
// to where a llama is going crosses the ramp's footprint (padded by about half a llama), it heads
// for the best corner of that padded box first. Deterministic, so nothing can cancel out or dither.
const RAMP_PAD = 4.3;
const _rt = new THREE.Vector3();
function rampLocal(x, z) {
  const dx = x - ramp.x, dz = z - ramp.z, c = Math.cos(ramp.rot), s = Math.sin(ramp.rot);
  return [dx * c - dz * s, dx * s + dz * c];
}
function rampWorld(lx, lz, out) {
  const c = Math.cos(ramp.rot), s = Math.sin(ramp.rot);
  return out.set(ramp.x + lx * c + lz * s, 0, ramp.z - lx * s + lz * c);
}
// does segment a→b (ramp-local) pass through the box |x|<hx, |z|<hz? (slab test)
function segHitsBox([ax, az], [bx, bz], hx, hz) {
  let t0 = 0, t1 = 1;
  for (const [p, d, h] of [[ax, bx - ax, hx], [az, bz - az, hz]]) {
    if (Math.abs(d) < 1e-9) { if (Math.abs(p) >= h) return false; continue; }
    let u = (-h - p) / d, v = (h - p) / d;
    if (u > v) [u, v] = [v, u];
    t0 = Math.max(t0, u); t1 = Math.min(t1, v);
    if (t0 >= t1) return false;
  }
  return true;
}
function routeAround(from, to) {
  if (!ramp) return to;
  const hx = RAMP_LEN / 2 + RAMP_PAD, hz = RAMP_W / 2 + RAMP_PAD;
  const a = rampLocal(from.x, from.z);
  let b = rampLocal(to.x, to.z);
  // a destination inside the padding gets nudged just outside it, through the nearest side
  if (Math.abs(b[0]) < hx && Math.abs(b[1]) < hz) {
    b = hx - Math.abs(b[0]) < hz - Math.abs(b[1]) ? [Math.sign(b[0]) * hx, b[1]] : [b[0], Math.sign(b[1]) * hz];
    to = rampWorld(b[0], b[1], _rt);
  }
  const ix = hx - 0.2, iz = hz - 0.2;                        // slightly inside, so edges count as clear
  if (!segHitsBox(a, b, ix, iz)) return to;
  const corners = [[hx, hz], [-hx, hz], [-hx, -hz], [hx, -hz]];
  const inside = Math.abs(a[0]) < ix && Math.abs(a[1]) < iz;
  const len = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  let best = null, bestCost = Infinity;
  corners.forEach((k, i) => {
    if (!inside && segHitsBox(a, k, ix, iz)) return;        // can't see this corner from here
    let cost = len(a, k);
    if (!segHitsBox(k, b, ix, iz)) cost += len(k, b);
    else {                                                   // round the next corner too
      const j = [corners[(i + 1) % 4], corners[(i + 3) % 4]].filter((q) => !segHitsBox(q, b, ix, iz));
      if (!j.length) return;
      cost += Math.min(...j.map((q) => len(k, q) + len(q, b)));
    }
    if (cost < bestCost) { bestCost = cost; best = k; }
  });
  return best ? rampWorld(best[0], best[1], _rt) : to;
}

// Ground height: 0 off the ramp, rising up the slope, flat on top. Only your llama climbs; the
// sides and back are walls, so the slope is the only way on or off.
const RAMP_EDGE = 1.1;      // how close to a side/back edge a climber may walk (about half a llama)
const RAMP_RAIL = 0.7;      // rails: how far inside the side/back edges the shoulders and hips stay
const RAMP_WALK = 6.0;      // top speed on (and right by) the ramp: a brisk walk, never a run
function groundHeight(x, z) {
  if (!ramp) return 0;
  const [lx, lz] = rampLocal(x, z), x0 = -RAMP_LEN / 2;
  if (Math.abs(lz) > RAMP_W / 2 || lx < x0 || lx > RAMP_LEN / 2) return 0;
  return lx < x0 + RAMP_SLOPE ? ((lx - x0) / RAMP_SLOPE) * RAMP_H : RAMP_H;
}
// What a climber stands on, given where its middle is. On the ramp the surface carries on past the
// sides and back (invisible rails: a foot or hip over an edge never drops to the floor); beside or
// behind it, level ground (a nose poking at a wall doesn't climb it); in front, the real thing.
function climbHeight(x, z, at) {
  if (!ramp) return 0;
  const x0 = -RAMP_LEN / 2;
  if (onRamp(at.x, at.z)) return clamp((rampLocal(x, z)[0] - x0) / RAMP_SLOPE, 0, 1) * RAMP_H;
  return rampLocal(at.x, at.z)[0] < x0 ? groundHeight(x, z) : 0;
}
// which way is up off the ground here (tilted on the slope, straight up everywhere else)
function groundNormal(x, z, out) {
  out.set(0, 1, 0);
  if (!ramp || !onRamp(x, z) || rampLocal(x, z)[0] >= -RAMP_LEN / 2 + RAMP_SLOPE) return out;
  const a = Math.atan2(RAMP_H, RAMP_SLOPE);
  return out.set(-Math.sin(a) * Math.cos(ramp.rot), Math.cos(a), Math.sin(a) * Math.sin(ramp.rot));
}
// where a climber should head next: up via the foot of the slope, down the same way
function climbRoute(from, to) {
  if (!ramp) return to;
  const onA = onRamp(from.x, from.z), onB = onRamp(to.x, to.z);
  if (!onA && !onB) return routeAround(from, to);
  if (onA && onB) return to;
  const a = rampLocal(from.x, from.z), b = rampLocal(to.x, to.z);
  const x0 = -RAMP_LEN / 2, w = RAMP_W / 2 - RAMP_EDGE - 0.6, hx = RAMP_LEN / 2 + RAMP_PAD;
  if (!onA) { // going up: straight on if lined up with the slope, otherwise round to its foot first
    if (a[0] < x0 && Math.abs(a[1]) < w) return to;
    return routeAround(from, rampWorld(-hx - 0.5, clamp(b[1], -w, w), new THREE.Vector3()));
  }
  // coming down: walk down the slope first, then on as normal
  if (a[0] > x0 - 0.5) return rampWorld(x0 - 3, clamp(a[1], -w, w), new THREE.Vector3());
  return routeAround(from, to);
}
// keep a climber on the walkable part: it can't step off a side or the back, or walk into a wall
// from the ground (only the slope's foot is open). Rails: its shoulders and hips (`body`, offsets
// along `heading`) stay over the walkway too, not just its middle, so turning near an edge slides
// it inward instead of hanging half of it off. Relaxed near the foot, where the sides are low.
function keepOnWalkable(pos, prev, heading, body) {
  if (!ramp || !onRamp(pos.x, pos.z)) return;
  const [lx, lz] = rampLocal(pos.x, pos.z), x0 = -RAMP_LEN / 2, w = RAMP_W / 2 - RAMP_EDGE;
  const [px] = rampLocal(prev.x, prev.z);
  if (!onRamp(prev.x, prev.z) && px >= x0) { pos.copy(prev); return; } // tried to enter through a wall
  let x = Math.min(lx, RAMP_LEN / 2 - RAMP_EDGE), z = clamp(lz, -w, w);
  const fx = Math.cos(heading - ramp.rot), fz = -Math.sin(heading - ramp.rot); // facing, ramp-local
  let pushX = 0, pushZ = 0;
  for (const d of body) {
    const bx = x + d * fx, bz = z + d * fz;
    const side = RAMP_W / 2 - RAMP_RAIL + Math.max(0, x0 + 1 - bx) * 3;
    if (Math.abs(bz) - side > Math.abs(pushZ)) pushZ = -Math.sign(bz) * (Math.abs(bz) - side);
    pushX = Math.min(pushX, RAMP_LEN / 2 - RAMP_RAIL - bx);
  }
  rampWorld(x + pushX, z + pushZ, pos);
}

// Everyone but your llama: the ramp is solid. Their paths are planned round it, but a llama going
// fast can't turn tightly enough to hold a corner (a herd racing to catch up), and avoidance or
// stepping aside can nudge one in. Any of its middle, shoulders, hips or head (`body`: offsets
// along `heading`) found inside gets pushed back out through the nearest side.
const RAMP_SOLID = 1.3;    // clearance from the walls (about half a llama's width)
function keepOffRamp(pos, heading, body) {
  if (!ramp) return;
  const hx = RAMP_LEN / 2 + RAMP_SOLID, hz = RAMP_W / 2 + RAMP_SOLID;
  const fx = Math.cos(heading - ramp.rot), fz = -Math.sin(heading - ramp.rot); // facing, ramp-local
  let [x, z] = rampLocal(pos.x, pos.z), moved = false;
  for (const d of body) {
    const bx = x + d * fx, bz = z + d * fz, px = hx - Math.abs(bx), pz = hz - Math.abs(bz);
    if (px <= 0 || pz <= 0) continue;                  // this point is clear
    if (px < pz) x += (bx < 0 ? -1 : 1) * px; else z += (bz < 0 ? -1 : 1) * pz;
    moved = true;
  }
  if (moved) rampWorld(x, z, pos);
}

// the flag ripples: a wave travels toward the tip, growing from the pole, with a little gusting
function updateRamp(dt) {
  if (!ramp) return;
  ramp.t += dt;
  const t = ramp.t, a = ramp.flag.geometry.attributes.position, base = ramp.flagBase;
  const gust = 0.75 + 0.25 * Math.sin(t * 0.7) * Math.sin(t * 1.9);
  for (let i = 0; i < a.count; i++) {
    const x = base[i * 3], k = x / FLAG.len;
    a.array[i * 3 + 2] = Math.sin(x * 2.1 - t * 7) * 0.35 * k * gust;          // ripple out of plane
    a.array[i * 3 + 1] = base[i * 3 + 1] - k * k * 0.25 * (1.2 - gust);        // droops a touch in lulls
  }
  a.needsUpdate = true;
  rampSummit(dt);
}

// The payoff for getting your llama to the top. 'glitch': it glitches, over a low, broken hum, and
// a shower rolls in (or, if it's already raining, lightning). 'rainbow': its coat goes rainbow, it
// pronks a few times and a little jingle plays. Once per climb (it has to get back down first).
const SUMMIT_FX = BLIGHT_ON ? 'glitch' : 'rainbow'; // ← the blight version glitches; the calm one goes rainbow, dances and jingles
const SUMMIT_LEN = 4;      // seconds of glitch / rainbow
const GLITCH_VOL = 0.012;  // its little digital chirps (0: silent)
const GLITCH_HUM = 0.05;   // its low, distorted hum (0: silent)
let summitReady = true, summitT = -1;
function rampSummit(dt) {
  const p = player.group.position;
  if (p.y < 0.05) summitReady = true;
  if (summitReady && p.y > RAMP_H - 0.01 && onRamp(p.x, p.z)) {
    summitReady = false; summitT = 0;
    player.summit = true;
    if (SUMMIT_FX === 'glitch') { if (!glitch.snd) glitch.snd = glitchSound(p); summitStorm(); }   // sfx:, rain: a shower, or lightning
    else { player.celebrate(); sfx.summit(p); }
  }
  if (summitT < 0) return;
  summitT += dt;
  if (glitch.snd && summitT > SUMMIT_LEN - 0.7) { glitchSoundEnd(glitch.snd); glitch.snd = null; } // sfx: winds down with the fade
  const k = smooth(0, 0.3, summitT) * (1 - smooth(SUMMIT_LEN - 0.8, SUMMIT_LEN, summitT));
  if (SUMMIT_FX === 'glitch') summitGlitch = k; else player.rainbow = k;
  if (summitT > SUMMIT_LEN) { summitT = -1; player.rainbow = 0; summitGlitch = 0; player.summit = false; }
}
// The glitch: just after each frame is drawn, the patch of screen around your llama is copied onto
// a 2D canvas above it, broken up — its colour channels pulled apart, slices shoved sideways, a
// frame held now and then — in stutters, with clean frames between.
let summitGlitch = 0;      // 0 off … 1 strongest
// Done on the GPU (copying the picture out of WebGL into a 2D canvas stalls it: ~2 ms a frame):
// when a new glitch frame starts, the screen is copied into a texture (a quick GPU-side copy), and
// one small shader draws the patch back over it — colour channels apart, slices shoved sideways —
// covering only that area. Between new frames the texture is left as it was (the held, frozen
// frames). No glitch: nothing extra is drawn at all.
const GLITCH_SLICES = 6;
const glitch = { mesh: null, hold: 0, on: false, snd: null };
if (FIXED_SPEED === null) {    // (the summit's glitch, and blight: your llama's)
  const uniforms = {
    tex: { value: null }, rect: { value: new THREE.Vector4() }, split: { value: 0 },
    slices: { value: Array.from({ length: GLITCH_SLICES }, () => new THREE.Vector3()) }, count: { value: 0 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, depthTest: false, depthWrite: false,
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `
      uniform sampler2D tex; uniform vec4 rect; uniform float split;
      uniform vec3 slices[${GLITCH_SLICES}]; uniform int count;
      void main() {
        vec2 q = gl_FragCoord.xy, p = q;            // q: this pixel; p: where in the copy it shows
        bool hit = q.x >= rect.x && q.x < rect.z && q.y >= rect.y && q.y < rect.w;
        for (int i = 0; i < ${GLITCH_SLICES}; i++) {  // a slice of the patch, shoved sideways
          if (i >= count) break;
          vec3 s = slices[i];                       // (band bottom, band top, shove)
          if (q.y >= s.x && q.y < s.y && q.x >= rect.x + s.z && q.x < rect.z + s.z) { p = vec2(q.x - s.z, q.y); hit = true; }
        }
        if (!hit) discard;
        vec2 size = vec2(textureSize(tex, 0));
        vec3 c = texture2D(tex, p / size).rgb;
        if (split > 0.0) c = vec3(texture2D(tex, (p + vec2(split, 0.0)) / size).r, texture2D(tex, (p - vec2(split, 0.0)) / size).gb);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3).setUsage(THREE.DynamicDrawUsage));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  glitch.mesh = new THREE.Mesh(geo, mat);
  glitch.mesh.frustumCulled = false;
  glitch.scene = new THREE.Scene();
  glitch.scene.add(glitch.mesh);
  glitch.cam = new THREE.Camera();
  glitch.size = new THREE.Vector2();
}
function drawGlitch() {
  const glitchK = Math.max(summitGlitch, blightGlitch);
  if (glitchK <= 0) { glitch.on = false; return; }
  const u = glitch.mesh.material.uniforms, size = renderer.getDrawingBufferSize(glitch.size), W = size.x, H = size.y;
  if (glitch.hold-- <= 0) {                              // a new frame (or a clean one)
    glitch.hold = Math.floor(Math.random() * 4);
    glitch.on = false;
    if (Math.random() > 0.3 + 0.55 * glitchK) { glitchGate(false); return; } // a clean frame (and silence)
    // the patch around your llama, in drawing-buffer pixels (y up, as WebGL counts)
    const k = W / innerWidth, r = player.screenRect(), pad = (r.x1 - r.x0) * 0.3;
    const x0 = Math.max(0, Math.floor((r.x0 - pad) * k)), x1 = Math.min(W, Math.ceil((r.x1 + pad) * k));
    const y0 = Math.max(0, Math.floor(H - (r.y1 + pad * 0.3) * k)), y1 = Math.min(H, Math.ceil(H - (r.y0 - pad * 0.3) * k));
    const w = x1 - x0, h = y1 - y0;
    if (w < 4 || h < 4) { glitchGate(false); return; }
    glitchGate(true);
    if (!glitch.tex || glitch.tex.image.width !== W || glitch.tex.image.height !== H) {
      glitch.tex?.dispose();
      glitch.tex = new THREE.FramebufferTexture(W, H);
      glitch.tex.minFilter = glitch.tex.magFilter = THREE.NearestFilter;
      u.tex.value = glitch.tex;
    }
    renderer.copyFramebufferToTexture(glitch.tex);       // this frame, frozen until the next
    u.rect.value.set(x0, y0, x1, y1);
    u.split.value = Math.random() < 0.75 ? Math.round((2 + Math.random() * 6) * k * glitchK) : 0;
    const unit = Math.max(2, Math.round(2 * k)), n = Math.min(GLITCH_SLICES, 1 + Math.floor(Math.random() * 5 * glitchK));
    let lo = x0, hi = x1;
    for (let i = 0; i < n; i++) {
      const sh = unit * (1 + Math.floor(Math.random() * h * 0.12 / unit)), sy = y0 + Math.floor(Math.random() * (h - sh));
      const dx = Math.round((Math.random() - 0.5) * w * 0.35 * glitchK / unit) * unit;
      u.slices.value[i].set(sy, sy + sh, dx);
      lo = Math.min(lo, x0 + dx); hi = Math.max(hi, x1 + dx);
    }
    u.count.value = n;
    // the quad: just the area it can touch
    const nx = (x) => (x / W) * 2 - 1, ny = (y) => (y / H) * 2 - 1, pos = glitch.mesh.geometry.attributes.position;
    pos.setXYZ(0, nx(lo), ny(y0), 0); pos.setXYZ(1, nx(hi), ny(y0), 0); pos.setXYZ(2, nx(hi), ny(y1), 0); pos.setXYZ(3, nx(lo), ny(y1), 0);
    pos.needsUpdate = true;
    glitch.on = true;
    if (Math.random() < 0.35) sfx.glitch(player.group.position);   // sfx:
  }
  if (!glitch.on) return;
  renderer.autoClear = false;
  renderer.render(glitch.scene, glitch.cam);
  renderer.autoClear = true;
}
// sfx: the glitch's hum — two low saws a semitone apart (they beat), crushed through a stepped
// distortion, plus a crackle. A gate cuts it in and out in step with the picture (on while a
// glitch frame shows, silent on clean ones), its pitch skips now and then, and at the end it
// winds down like a tape stopping. It opens on a low boom.
function glitchSound(pos, boom = true) {
  const at = sfxAt(pos); if (!at || !GLITCH_HUM) return null;
  const [v, pan] = at, t = actx.currentTime;
  if (boom) sfxTone(t, pan, { from: 95, to: 28, gain: 0.4 * v, decay: 0.9 });   // the boom
  const gate = actx.createGain(), crush = actx.createWaveShaper(), lp = actx.createBiquadFilter(), pn = actx.createStereoPanner();
  const curve = new Float32Array(512);
  for (let i = 0; i < 512; i++) curve[i] = Math.round(Math.tanh((i / 255.5 - 1) * 5) * 3) / 3; // a few hard steps
  crush.curve = curve;
  lp.type = 'lowpass'; lp.frequency.value = 1600;
  gate.gain.value = 0;
  pn.pan.value = pan;
  crush.connect(lp).connect(gate).connect(pn).connect(sfxOut);
  const oscs = [55, 58.27].map((hz) => {
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'sawtooth'; o.frequency.value = hz; g.gain.value = 0.5;
    o.connect(g).connect(crush);
    o.start(t);
    return o;
  });
  const crackle = actx.createBufferSource(), bp = actx.createBiquadFilter(), cg = actx.createGain();
  crackle.buffer = sfxNoise; crackle.loop = true;
  bp.type = 'bandpass'; bp.frequency.value = 2400; bp.Q.value = 0.8; cg.gain.value = 0.25;
  crackle.connect(bp).connect(cg).connect(gate);
  crackle.start(t);
  return { gate, oscs, crackle, level: GLITCH_HUM * v };
}
function glitchGate(on) {
  const snd = glitch.snd; if (!snd) return;
  const t = actx.currentTime;
  snd.gate.gain.setTargetAtTime(on ? snd.level * Math.max(summitGlitch, blightGlitch) : 0, t, 0.004);
  if (on && Math.random() < 0.3) for (const o of snd.oscs) o.detune.setValueAtTime(pick([-1200, -500, 0, 0, 300, 700]), t); // a skip
}
function glitchSoundEnd(snd) {
  const t = actx.currentTime;
  snd.gate.gain.cancelScheduledValues(t);
  snd.gate.gain.setTargetAtTime(snd.level, t, 0.01);            // held on through the wind-down...
  snd.gate.gain.setTargetAtTime(0, t + 0.45, 0.08);              // ...then gone
  for (const o of snd.oscs) { o.detune.setValueAtTime(0, t); o.frequency.exponentialRampToValueAtTime(o.frequency.value * 0.12, t + 0.7); o.stop(t + 1); }
  snd.crackle.stop(t + 1);
}

function createLlama({ id, coat, brain: brainKind, x = 0, z = 0, heading: heading0 = 0 }) {
  const self = { id, hovered: false, climbs: brainKind === 'cursor' }; // ramp: only yours climbs
  const mine = brainKind === 'cursor';  // sfx: only yours makes sounds (besides the ball)
  const colNear = new THREE.Color(coat.body), colFar = new THREE.Color(coat.far);
  const baseNear = colNear.clone(), baseFar = colFar.clone(), baseEye = new THREE.Color(); // blight: the healthy colours
  const llama = new THREE.Group();
  llama.position.set(x, 0, z);
  scene.add(llama);
  // a part: an invisible transform node whose shape is drawn by the shared batch for its geometry
  // (.geometry is kept so screen-space bounds can still be measured from it)
  const parts = [];
  function part(geo, color, opts) {
    const obj = new THREE.Object3D();
    obj.geometry = geo;
    parts.push({ obj, color, batch: batchFor(geo, opts), fur: !opts }); // fur: what turns rainbow
    return obj;
  }

  // blight: everything hangs off a pivot group, so the whole llama (legs too) can tip onto its side
  const tipG = new THREE.Group();
  llama.add(tipG);
  const rig = new THREE.Group();  // gets bounce + pitch + roll
  tipG.add(rig);

  const body = part(capsule(1.2, 3.35), colNear);
  body.rotation.z = Math.PI / 2;
  body.scale.z = 0.92;
  rig.add(body);

  // tail: short tuft, droops at rest, lifts when galloping
  const tail = new THREE.Group();
  tail.position.set(-2.55, 0.5, 0);
  rig.add(tail);
  const tailMesh = part(capsule(0.32, 0.5), colNear);
  tailMesh.rotation.z = Math.PI / 2;
  tailMesh.position.x = -0.45;
  tail.add(tailMesh);

  // neck
  const neck = new THREE.Group();
  neck.position.set(1.88, 0.1, 0);
  neck.rotation.z = NECK_TILT;
  rig.add(neck);
  const neckMesh = part(capsule(1.0, NECK_LEN), colNear);
  neckMesh.position.y = NECK_LEN / 2;
  neckMesh.scale.z = 0.9;
  neck.add(neckMesh);

  // head (top cap of the neck) – counter-tilted so the face stays upright
  const head = new THREE.Group();
  head.position.y = NECK_LEN;
  neck.add(head);
  const headYaw = new THREE.Group();
  head.add(headYaw);

  const ears = [];
  for (const s of [-1, 1]) {
    const ear = new THREE.Group();
    ear.position.set(-0.25, 0.6, s * 0.55);          // pivot sunk into the head so the base never shows
    const m = part(capsule(0.26, 0.7), colNear);
    m.position.y = 0.425;
    ear.add(m);
    ear.rotation.x = s * 0.12;
    headYaw.add(ear);
    ears.push({ g: ear, twitch: 0, next: 1 + Math.random() * 4 });
  }

  // face: one mesh for both eyes (blinks by squashing it), one for nose + mouth
  // eyes: pale on dark coats, dark on light coats (so they never disappear into the fur)
  const eyeColor = new THREE.Color();
  const setEyes = () => { eyeColor.set(colNear.getHSL({}).l > 0.55 ? 0x333333 : C.eye); baseEye.copy(eyeColor); };
  setEyes();
  const eyePair = part(EYES_GEO, eyeColor, { shadow: false });
  eyePair.position.set(0.72, 0.42, 0);
  headYaw.add(eyePair);
  const eyes = [eyePair];
  const xEyes = part(X_EYES_GEO, eyeColor, { shadow: false }); // blight: shown once it has keeled over
  xEyes.position.copy(eyePair.position);
  xEyes.scale.setScalar(0);
  headYaw.add(xEyes);
  const muzzle = part(MUZZLE_GEO, null, { tint: false, shadow: false, material: MUZZLE_MAT });
  headYaw.add(muzzle);

  function segment(parent, len, color) {
    const g = new THREE.Group();
    const m = part(capsule(LEG_R, len), color);
    m.rotation.z = -Math.PI / 2;
    m.position.x = len / 2;
    g.add(m);
    parent.add(g);
    return g;
  }
  function makeLeg({ hipX, footX, side, front, L1, L2 }) {
    const color = new THREE.Color(coat.body); // lerped toward the far shade each frame
    const root = new THREE.Group();
    tipG.add(root);
    return {
      hip: new THREE.Vector3(hipX, HIP_Y, side * LEG_Z), // relative to body center
      footX, side, front, L1, L2, color, root,
      upper: segment(root, L1, color),
      lower: segment(root, L2, color),
      fx: footX, fy: FOOT_Y, // current foot target, llama-local
      jx: 0,                 // hip/shoulder protraction offset
    };
  }
  const legs = {
    LF: makeLeg({ hipX:  1.70, footX:  1.70,             side:  1, front: true,  ...FRONT }),
    RF: makeLeg({ hipX:  1.70, footX:  1.70,             side: -1, front: true,  ...FRONT }),
    LH: makeLeg({ hipX: -1.75, footX: -1.75 - HOCK_BACK, side:  1, front: false, ...HIND }),
    RH: makeLeg({ hipX: -1.75, footX: -1.75 - HOCK_BACK, side: -1, front: false, ...HIND }),
  };
  const legList = Object.entries(legs);



  // ---------- state ----------
  let heading = heading0, omega = 0, speed = 0, vTarget = 0, phase = 0;
  let turning = false, yawLook = 0, blinkT = 2 + Math.random() * 3, time = 0;
  let wPace = 0, wGallop = 0;       // smoothed gait weights
  let rollS = 0, pitchS = 0, yS = RIG_Y; // smoothed body pose
  let escapeDir = 0, escapeT = 0, wasBlocked = false; // committed turn direction when blocked
  let tilt = 0, lift = 0;               // ramp: body pitch and lift from the ground underfoot
  let earFlop = 0;                      // ears lagging each step
  const HIP_FX = 1.7, HIP_HX = -1.75;   // shoulder / hip positions along the body
  const HEAD_X = 3.2;                   // roughly where the head is, ahead of the middle
  const _prev = new THREE.Vector3(), _fw = new THREE.Vector3();


  let kushT = 0, kushDir = 0;     // lie-down timeline 0..1; +1 lying down, -1 getting up
  let fF = 0, fH = 0;             // smoothed fold amounts, front / hind
  let lookT = 0, lookYaw = 0, lookNod = 0, nodS = 0;
  let joy = 0, perk = 0, smile = 0;
  let pet = 0, petS = 0, petting = false, petHeart = 0, petHum = 0; // pet: contentment from being stroked
  let hopT = -1;                  // single happy hop, seconds (-1 = not hopping)
  let hopBig = 1;                 // how high that hop goes (a ball hit: higher)
  let dropT = -1;                 // intro: dropped into the scene, seconds (-1 = not dropping)
  let camLook = 0;                // intro: then a look at the camera (seconds left; it starts after a beat)
  let startleT = 0, startleYaw = 0; // hit by a ball: stopped short, looking where it came from
  let shakeIn = -1, shakeT = -1;  // rain: a shake-off after a shower (countdown to it, then its timeline)
  let dance = null;               // { t } – pronking happy dance
  let goalBall = null;           // ball being walked to (or, piles: a piece someone clicked)
  let pieceGoal = null;           // piles: a piece it's been asked to kick
  let act = null;                 // { t, ball, bx, bz, side } – a kick in progress
  let fall = null;                // blight: { t, side, k, up } keeling over / lying on its side / getting back up
  let fallWant = false;           // blight: it's time (waits until it's standing and not busy)
  let jolt = null;                // blight: a fallen one, clicked: { t, dx, dz, done } a little hop and shift
  let curious = 0;                // blight: looking at a fallen one (0..1, smoothed)

  // hit by a ball: stops short with a big startled jump (or scrambles up if lying down), perks
  // up, says "bip-bip", and looks toward where the ball came from for a moment
  function bonk(from) {
    if (fall) return;                              // blight: it doesn't react any more
    sfx.boop(llama.position);
    perk = 1;
    brain.onPoke();
    if (kushT > 0) { kushDir = -1; return; }
    if (dance) return;
    hopT = 0; hopBig = 1.5;
    startleT = 0.9;
    if (speed > 2) puff(llama.position.x, llama.position.y, llama.position.z, 4); // dust: skids
    speed *= 0.35;                                  // pulls up short
    startleYaw = wrap(Math.atan2(-(from.z - llama.position.z), from.x - llama.position.x) - heading);
  }
  // piles: asked to kick a piece — walks to it and kicks it, just like a ball
  function dropPieceGoal() {
    const i = pieceGoal ? piles.targets.indexOf(pieceGoal) : -1;
    if (i >= 0) piles.targets.splice(i, 1);
    pieceGoal = null; if (goalBall?.piece) goalBall = null;
  }
  // blight: before it goes it staggers round to (roughly) face you or face away — whichever's
  // nearer — so it falls across the screen, flat on its side, legs out sideways
  function keelFace() {
    const a = CAM_HEADING + (Math.random() - 0.5) * 0.6, b = a + Math.PI;
    return Math.abs(wrap(a - heading)) < Math.abs(wrap(b - heading)) ? a : b;
  }
  // ...and which side it falls to: its preferred one, unless the ramp or another llama is there
  function keelSide() {
    const s = KEEL_SIDE, p = llama.position;
    const blocked = (d) => {
      const x = p.x + Math.sin(heading) * d * 4.5, z = p.z + Math.cos(heading) * d * 4.5;
      return onRamp(x, z, 2) || llamas.some((o) => o !== self && Math.hypot(o.group.position.x - x, o.group.position.z - z) < 4);
    };
    return blocked(s) && !blocked(-s) ? -s : s;
  }
  function poke(quiet = false) {
    if (fall) {                                    // blight: a fallen one only shifts, like a toy would
      if (!fall.up && fall.t > KEEL_SWAY + KEEL_TIP && !jolt && !self.gone) {
        const l = Math.hypot(camDir.x, camDir.z) || 1, r = (Math.random() - 0.5) * 0.6;
        jolt = { t: 0, done: 0, dx: -camDir.x / l * 0.9 + r, dz: -camDir.z / l * 0.9 - r };
        sfx.keel(llama.position);                  // sfx:
      }
      return;
    }
    if (!mine && !quiet) sfx.boop(llama.position); // sfx: (yours: its hop makes the sound)
    if (ill()) { perk = 1; brain.onPoke(); if (kushT > 0) kushDir = -1; return; } // blight: sick — it notices, but no hop or dance
    joy += 1;
    perk = 1;
    smile = Math.min(1, joy / 2.5);
    brain.onPoke();                                 // being poked counts as attention
    if (kushT > 0) { kushDir = -1; return; }       // woken up: get up
    if (dance) return;
    if (joy >= 2.5) { dance = { t: 0, song: true }; hopT = -1; sfx.dance(llama.position); } // ~third quick poke: happy dance (sfx: with a jingle)
    else if (hopT < 0) { hopT = 0; hopBig = 1; }
  }


  const ill = () => (self.sick ?? 0) > 0.2;          // blight: visibly sick (no hearts, no dancing)
  self.ill = ill;

  // --- brain: where to go, when to rest ---
  const brain = brainKind === 'cursor' ? {
    goal: null, stopDist: STOP_DIST, maxSpeed: MAX_SPEED, ballSpeed: MAX_SPEED, turnDist: 5,
    hold: 0, since: 99,             // intro: after the drop it stays put a moment, then eases into moving
    tick(dt) {
      this.hold = Math.max(0, this.hold - dt);
      this.goal = hasTarget && this.hold <= 0 ? target : null;
      if (this.hold <= 0) this.since += dt;
      this.maxSpeed = lerp(SETTLE_WALK, MAX_SPEED, smooth(0, SETTLE_EASE, this.since)); // (a walk at first, however far the cursor)
    },
    idle: () => pointerIdle,
    wantKush: () => pointerIdle > KUSH_AFTER,
    onPoke() { pointerIdle = 0; },
  } : {
    // stroll to a random spot, hang around a while (sometimes lie down for a nap), repeat
    goal: null, dest: new THREE.Vector3(), stopDist: 1.0, maxSpeed: 3.2, ballSpeed: 9, turnDist: 1.5,
    wait: Math.random() * 0.5, idleT: 0, napFor: 0,   // (sets off almost straight away: the scene's alive from the first frame)
    tick(dt) {
      this.idleT += dt;
      // gather: while following, head for the slot behind the leader; on release, wander again
      if (self.followTarget) { this.goal = self.followTarget; this.napFor = 0; this.maxSpeed = 15; this.following = true; return; }
      if (this.following) { this.following = false; this.goal = null; this.wait = 0.5 + Math.random() * 2; }
      // your llama has right of way: standing (even napping) in its path, it shuffles aside
      if (this.yieldT > 0) {
        if ((this.yieldT -= dt) > 0) return;
        this.goal = null; this.wait = 1 + Math.random() * 2; self.yielding = false;
      }
      if (stepAside(llama.position, this.dest)) {
        this.goal = this.dest; this.napFor = 0; this.yieldT = 1.6; this.maxSpeed = 5.5; this.stopDist = 1.0; self.yielding = true;
        this.best = Infinity; this.stuckT = 0;
        return;
      }
      // blight: one has fallen nearby — walks over, stops a little short, and looks at it a while
      if (this.inspect) {
        const g = this.inspect;
        if (g.other.gone || !llamas.includes(g.other) || (g.t += dt) > 22) { this.endInspect(); return; }
        this.goal = g.spot; this.stopDist = 1.0; this.maxSpeed = 3.2;
        if (Math.hypot(g.spot.x - llama.position.x, g.spot.z - llama.position.z) < 2 && speed < 0.3 && (g.near += dt) > INSPECT_LOOK) this.endInspect();
        return;
      }
      // greet: two that meet sometimes walk up nose to nose, linger a moment, and go on their way
      this.greetCool -= dt;
      if (this.greet) {
        const g = this.greet, o = g.other, d = llama.position.distanceTo(o.group.position);
        if (!llamas.includes(o) || o.greeting !== self || (g.t += dt) > 10) { this.endGreet(); return; }
        this.goal = o.group.position; this.stopDist = GREET_DIST; this.maxSpeed = 3.2;
        if (d < GREET_DIST + 0.8 && speed < 0.3) {
          if (g.met === 0) { perk = 1; if (g.first && Math.random() < 0.3) heart(head); }
          if ((g.met += dt) > 1.8) this.endGreet();
        }
        return;
      }
      if (this.greetCool <= 0 && this.canGreet()) {
        const o = llamas.find((q) => q !== self && q.canGreet?.() && q.group.position.distanceTo(llama.position) < 11);
        if (o && Math.random() < 0.6 * dt) { this.startGreet(o, true); o.startGreet(self, false); return; }
      }
      if (this.napFor > 0) { this.napFor -= dt; return; }
      if (this.goal) {
        const d = Math.hypot(this.goal.x - llama.position.x, this.goal.z - llama.position.z);
        // no progress for a while (path blocked, someone standing there): settle where it is
        if (d < this.best - 0.3) { this.best = d; this.stuckT = 0; } else this.stuckT += dt;
        if ((d < this.stopDist + 0.6 && speed < 0.4) || this.stuckT > 3) {
          this.goal = null; this.idleT = 0; this.wait = 3 + Math.random() * 7;
          if (Math.random() < 0.2) this.napFor = 12 + Math.random() * 14;
        }
        return;
      }
      if (goalBall || act || kushT > 0) return;
      this.wait -= dt;
      if (this.wait <= 0) {
        // somewhere free: away from every other llama, where they're heading, and the ramp
        for (let i = 0; i < 16; i++) {
          randomGroundPoint(this.dest, llama.position, 8);
          const free = !onRamp(this.dest.x, this.dest.z, 5) /* ramp: */ && !(vd.on && Math.hypot(this.dest.x - vd.x, this.dest.z - vd.z) < vd.r + 8) /* void: */ && llamas.every((o) => o === self ||
            (Math.hypot(o.group.position.x - this.dest.x, o.group.position.z - this.dest.z) > DEST_CLEAR &&
             !(o.dest && Math.hypot(o.dest.x - this.dest.x, o.dest.z - this.dest.z) < DEST_CLEAR)));
          if (free) break;
        }
        this.goal = this.dest; this.best = Infinity; this.stuckT = 0;
        this.maxSpeed = Math.random() < 0.25 ? 5.5 : 3.2; // usually a walk, sometimes a brisk pace
      }
    },
    idle() { return this.goal ? 0 : this.idleT; },
    best: Infinity, stuckT: 0,
    greet: null, greetCool: 8 + Math.random() * 20,
    canGreet() { return (self.sick ?? 0) < 0.3 && !fall /* blight: the sick keep to themselves */ && !this.greet && this.greetCool <= 0 && !this.following && !self.yielding && this.napFor <= 0 && !goalBall && !act && kushT === 0 && !dance && pet < 0.15; },
    inspect: null,
    canInspect() { return !this.inspect && !this.greet && !this.following && !self.yielding && !fall && !fallWant && kushT === 0 && !dance && (self.sick ?? 0) < 0.6; },
    startInspect(other) {
      const o = other.group.position, dx = llama.position.x - o.x, dz = llama.position.z - o.z, d = Math.hypot(dx, dz) || 1;
      this.inspect = { other, t: 0, near: 0, spot: new THREE.Vector3(o.x + dx / d * 6.5, 0, o.z + dz / d * 6.5) };
      this.goal = null; this.napFor = 0; this.best = Infinity; this.stuckT = 0; perk = 1;   // (ears up: what was that?)
    },
    endInspect() { this.inspect = null; this.goal = null; this.stopDist = 1.0; this.wait = 1 + Math.random() * 2; },
    startGreet(other, first) { this.greet = { other, t: 0, met: 0, first }; self.greeting = other; this.goal = null; },
    endGreet() {
      this.greet = null; self.greeting = null; this.goal = null; this.stopDist = 1.0;
      this.wait = 0.5 + Math.random() * 1.5; this.greetCool = 25 + Math.random() * 25;
    },
    wantKush() { return this.napFor > 0; },
    onPoke() { this.napFor = 0; this.idleT = 0; },
  };

  function update(dt) {
    if (self.gone) return;                          // void: falling into it — moved from outside
    time += dt;

    // blight: sickness drains the coat toward a pale grey, slows it down, makes it unsteady
    const sick = self.sick ?? 0;
    const drain = fall ? 1 : smooth(0.08, 1, sick), weak = fall ? 1 : smooth(0.4, 1, sick);
    if (drain > 0 || self.drained) {
      for (const [c, b] of [[colNear, baseNear], [colFar, baseFar]]) {
        const h = b.getHSL({});
        c.setHSL(h.h, h.s * (1 - 0.9 * drain), lerp(h.l, 0.7, 0.5 * drain));
      }
      eyeColor.set(colNear.getHSL(_hsl).l > 0.55 ? _dimEye : C.eye);  // stays in contrast with the paling coat
      self.drained = drain > 0;
    }
    if (fallWant && !fall && kushT === 0 && !act && !dance && hopT < 0 && dropT < 0) {
      fall = { t: 0, side: 0, k: 0, up: false, shift: 0, face: keelFace() };
      fallWant = false;
    }

    // --- behaviour timers ---
    if (!fall) brain.tick(dt);
    joy = Math.max(0, joy - dt * 0.25);
    perk = Math.max(0, perk - dt * 0.8);
    smile = Math.max(0, smile - dt * 0.4);

    // pet: stroked enough, it settles — stops, closes its eyes, tilts its head, hums, and now and
    // then a heart floats up. It fades back to normal a little while after the stroking stops.
    if (fall) pet = 0;                              // blight:
    pet = Math.max(0, pet - dt * 0.25);
    if (!petting && pet > 0.45) { petting = true; petHeart = 0.5; petHum = 0.15; }
    if (petting && pet < 0.2) petting = false;
    petS = damp(petS, petting ? 1 : 0, 4, dt);
    self.petting = petting;
    if (petting) {
      smile = 1;
      if ((petHeart -= dt) < 0) { if (!ill()) heart(head); petHeart = 1.4 + Math.random(); } // (blight: no hearts from the sick)
      if ((petHum -= dt) < 0) { sfx.hum(llama.position); petHum = 2.2 + Math.random() * 0.8; } // sfx:
    }

    if (pieceGoal && (pieceGoal.t += dt) > 12) dropPieceGoal();       // piles: couldn't get there, never mind
    if (!act) goalBall = fall ? null : pieceGoal ?? (FIXED_SPEED === null && !self.followLeader /* gather: in line, ignore balls */
      ? nearestBall(id, llama.position.x, llama.position.z, goalBall) : null);
    if (goalBall && kushT > 0 && kushDir !== -1) kushDir = -1; // a ball is worth getting up for

    const still = speed < 0.05 && Math.abs(omega) < 0.05 && !dance && hopT < 0 && !act && !goalBall;
    // lie down when the brain wants a rest (cursor: long stillness); get up when it doesn't
    if (kushDir === 0 && kushT === 0 && still && brain.wantKush()) kushDir = 1;
    if (kushDir === 1 && !brain.wantKush()) kushDir = -1;
    if (kushDir !== 0) {
      const k0 = kushT;
      kushT = clamp(kushT + dt * (kushDir > 0 ? 1 / 2.4 : -1 / 1.8), 0, 1);
      if (mine && kushDir > 0 && k0 === 0) sfx.lieDown(llama.position); // sfx:
      if (mine && kushDir < 0 && k0 === 1) sfx.getUp(llama.position);   // sfx:
      if (kushT === 0) kushDir = 0;
    }

    // dance: pronk, hearts at each take-off
    let danceY = 0;
    if (dance) {
      const t0 = dance.t;
      dance.t += dt; perk = 1; smile = 1;
      for (let k = 0; k < 3; k++) if (t0 < k * PRONK + 0.13 && dance.t >= k * PRONK + 0.13) heart(head);
      for (let k = 0; k < 3; k++) if (mine && !self.summit && !dance.song && t0 < k * PRONK + 0.12 && dance.t >= k * PRONK + 0.12) sfx.pronk(llama.position, k); // sfx:
      for (let k = 0; k < 3; k++) if (t0 < k * PRONK + 0.5 && dance.t >= k * PRONK + 0.5) puff(llama.position.x, llama.position.y, llama.position.z, 5); // dust: each pronk lands
      danceY = danceHop(dance.t);
      if (dance.t > DANCE_LEN) { dance = null; joy = 0; }
    }
    // ball actions
    if (act) {
      const t0 = act.t, t = (act.t += dt);
      const at = (k) => t0 < k && t >= k; // fires once when the timeline passes k
      // wind up, punt it (a little off-straight), watch it go
      if (at(0.38)) {
        sfx.kick(act.ball.pos);                                    // sfx:
        if (act.ball.piece) { kickPiece(act.ball.piece, heading + (Math.random() - 0.5) * 0.4); dropPieceGoal(); } // piles:
        else kickBall(act.ball, heading + (Math.random() - 0.5) * 0.5, 26, self);
        perk = 1;
      }
      if (at(1.0)) smile = 1;
      if (t > KICK_LEN) act = null;
    }
    if (goalBall && !goalBall.piece && !balls.includes(goalBall)) goalBall = null; // gone (by us or someone else)
    startleT = Math.max(0, startleT - dt);
    // rain: shower over — after a moment, a quick full-body shake, flinging off a few droplets
    if (shakeIn > 0 && (shakeIn -= dt) <= 0) {
      if (kushT === 0 && !dance && !fall) {
        shakeT = 0;
        sfx.shake(llama.position, mine);                // sfx: its own little jingle
        puff(llama.position.x, llama.position.y + 4.6, llama.position.z, 10, { col: DROPLET_COL, r: 0.09, v: 3, vy: 2.5, g: 14, spread: 1.4 });
      }
    }
    if (shakeT >= 0 && (shakeT += dt) > 0.9) shakeT = -1;
    const busy = fall !== null || kushT > 0 || dance !== null || act !== null || pet > 0.15 || startleT > 0 || shakeT >= 0; // (pet: pauses as soon as you start stroking)

    // --- steering: walk to a ball if there is one, else wherever the brain wants to go ---
    const goal = goalBall ? goalBall.pos : (brain.goal || llama.position);
    const stopDist = goalBall ? KICK_REACH : brain.stopDist;
    const dx = goal.x - llama.position.x, dz = goal.z - llama.position.z;
    const dist = goalBall || brain.goal ? Math.hypot(dx, dz) : 0;
    const way = dist > 0.5 ? (self.climbs ? climbRoute : routeAround)(llama.position, goal) : goal; // ramp: around it (or up it)
    const diff = dist > 0.5 ? wrap(Math.atan2(-(way.z - llama.position.z), way.x - llama.position.x) - heading) : 0;

    // --- avoidance: curve around llamas in the path, wait if one is right in front ---
    // A llama standing at the goal itself (you walking up to one) is braked for, not swerved
    // around; so is the llama being followed (trail it, never dodge it).
    let steer = 0, blockAhead = Infinity, leaderAhead = Infinity;
    let hardBlock = Infinity; // blocked by something that isn't what we're walking up to
    if (!busy && FIXED_SPEED === null && dist > (goalBall ? 0.5 : brain.stopDist)) {
      const c = Math.cos(heading), sn = Math.sin(heading);
      const look = AVOID_LOOK + speed * 0.9; // look further ahead the faster it goes
      for (const o of llamas) {
        if (o === self) continue;
        if (self.yielding) continue;  // stepping out of your llama's way (to its own side, away from it): just go
        const op = o.group.position, ox = op.x - llama.position.x, oz = op.z - llama.position.z;
        const ahead = ox * c - oz * sn, side = ox * sn + oz * c; // llama-local: +x ahead, +z right
        if (ahead < 0 || ahead > Math.min(look, dist + CONTACT) || Math.abs(side) > AVOID_WIDTH) continue;
        if (mine && !o.fallen) {                       // yours has right of way: it steers round the living but never
          if (Math.hypot(op.x - goal.x, op.z - goal.z) < CONTACT) continue; // stops for them (they're nudged aside: personal space)
          steer += (side >= 0 ? 1 : -1) * (1 - ahead / look) * (1 - Math.abs(side) / AVOID_WIDTH);
          continue;
        }
        if (o === self.followLeader) {                 // gather: trail the leader, only dodge it up close
          leaderAhead = Math.min(leaderAhead, ahead);
          if (ahead > CONTACT + 1) continue;
        } else blockAhead = Math.min(blockAhead, ahead);
        if (Math.hypot(op.x - goal.x, op.z - goal.z) < CONTACT) continue; // it's what we're walking up to
        if (o !== self.followLeader) hardBlock = Math.min(hardBlock, ahead);
        const w = (1 - ahead / look) * (1 - Math.abs(side) / AVOID_WIDTH);
        steer += (side >= 0 ? 1 : -1) * w; // obstacle on the right → veer left (and vice versa)
      }
    }
    const steerAng = clamp(steer * 1.6, -1.2, 1.2);
    const course = wrap(diff + steerAng); // heading change actually steered toward

    // arrived at a ball, lined up: claim it and act (remember where it sits, llama-local)
    if (goalBall && !busy && dist < stopDist + 0.35 && Math.abs(diff) < 0.15 && speed < 1) {
      goalBall.claimedBy = id;
      const c = Math.cos(heading), sn = Math.sin(heading);
      const bx = dx * c - dz * sn, bz = dx * sn + dz * c;
      // kick with the leg on the ball's side; if it's dead centre, use the leg facing the camera
      const camSide = camDir.x * sn + camDir.z * c >= 0 ? 1 : -1;
      act = { t: 0, ball: goalBall, bx, bz, side: Math.abs(bz) > 0.3 ? Math.sign(bz) : camSide };
    }

    vTarget = dist < stopDist ? 0 : Math.min(goalBall ? brain.ballSpeed : brain.maxSpeed, (dist - stopDist) * 0.85);
    if (goalBall && dist < stopDist + 0.35 && Math.abs(diff) >= 0.15) vTarget = 0; // close but misaligned: turn first
    const v0 = vTarget;
    vTarget *= clamp(0.5 + 0.5 * Math.cos(course), 0, 1) ** 1.5; // ease off to turn...
    if (!goalBall && dist > ARC_FROM && !onRamp(llama.position.x, llama.position.z, 1)) vTarget = Math.max(vTarget, Math.min(v0, ARC_SPEED)); // ...but far off, keep walking round (ramp: no room — turn where it stands)
    vTarget *= smooth(CONTACT, CONTACT + 5 + speed * 0.9, blockAhead); // ease off behind another llama (sooner when fast)
    vTarget *= smooth(CONTACT, CONTACT + 1.5, leaderAhead);             // trailing: only hold back right behind
    // ramp: always walk on it, and slow to a walk well before stepping onto it
    if (self.climbs && (onRamp(llama.position.x, llama.position.z, 1) ||
        (onRamp(goal.x, goal.z) && onRamp(llama.position.x, llama.position.z, 14)))) vTarget = Math.min(vTarget, RAMP_WALK);
    vTarget *= (1 - 0.55 * weak) * (1 - 0.45 * weak * (0.5 + 0.5 * Math.sin(time * 2.1))); // blight: slower, in lurches
    if (busy) vTarget = 0;
    // smooth approach with capped acceleration
    const dv = damp(speed, vTarget, 2.2, dt) - speed;
    // braking: normally gentle, but firm when another llama is about to be touched
    const decel = Math.min(blockAhead, leaderAhead) < CONTACT + 2 + speed * 0.4 ? 30 : DECEL;
    speed += clamp(dv, -decel * dt, ACCEL * dt);
    if (FIXED_SPEED !== null) vTarget = speed = FIXED_SPEED;

    // turn in place only for a target clearly outside the body (balls: line up from close range)
    // Blocked right in front: forget the goal for a moment and turn decisively away from the
    // obstacle. (Otherwise "turn away" and "turn toward the goal" can cancel out exactly and it
    // would stand there nose-to-post forever.)
    // (Wanting to move but held at contact range always means turning, so it can never freeze.
    // It commits to one direction for a couple of seconds — facing the middle of a wide obstacle
    // the left/right pulls nearly cancel, and re-deciding every frame would just dither — and
    // keeps a bias that way while it skirts the obstacle afterwards.)
    // Only "blocked" if the way it wants to go is roughly ahead (a goal behind it just needs a
    // turn), with hysteresis so hovering at the threshold can't flicker it on and off.
    const blocked = !busy && dist > stopDist && Math.abs(course) < 1.6 &&
      hardBlock < CONTACT + (wasBlocked ? 1.2 : 0.3);
    wasBlocked = blocked;
    if (blocked) { if (!escapeDir) escapeDir = Math.sign(steerAng) || 1; escapeT = 2; }
    else if ((escapeT -= dt) <= 0) escapeDir = 0;
    const turnTo = blocked ? escapeDir * Math.max(Math.abs(steerAng), 0.8)
      : wrap(course + escapeDir * 0.5 * clamp(escapeT, 0, 1));
    if (!turning && !busy && dist > (goalBall ? 1.5 : Math.min(brain.turnDist, stopDist + 0.5)) && Math.abs(course) > (goalBall ? 0.15 : 0.6)) turning = true; // (a goal close behind it too: it used to just stand there)
    if (!turning && !busy && blockAhead < CONTACT + 2 && Math.abs(steerAng) > 0.2) turning = true; // blocked: turn aside
    if (turning && !blocked && Math.abs(course) < 0.05) turning = false;
    const maxTurn = speed > 0.3 ? 1.1 + speed * 0.06 : (turning || blocked ? 1.2 : 0);
    let wantOmega = FIXED_SPEED !== null || busy ? 0 : clamp(turnTo * 2.2, -maxTurn, maxTurn);
    // yours turns to face you while it dances (a little three-quarter, from whichever side is nearer)
    if (mine && dance) {
      const face = CAM_HEADING + (wrap(heading - CAM_HEADING) >= 0 ? 0.35 : -0.35);
      wantOmega = clamp(wrap(face - heading) * 5, -5, 5);
    }
    if (camLook > 0 && camLook < 2.1 && speed < 0.5) {   // intro: after landing, turns a little toward you
      const face = CAM_HEADING + (wrap(heading - CAM_HEADING) >= 0 ? 0.6 : -0.6);
      wantOmega = clamp(wrap(face - heading) * 3, -3, 3);
    }
    if (fall && !fall.up && fall.t < KEEL_SWAY - 0.3) wantOmega = clamp(wrap(fall.face - heading) * 2.5, -1.4, 1.4); // blight: staggers round
    else if (weak > 0 && speed > 0.3) wantOmega += weak * 1.1 * Math.sin(time * 1.3);   // blight: a drunken weave
    omega = damp(omega, wantOmega, 4, dt);
    const h0 = heading;
    heading += omega * dt;
    llama.rotation.y = heading;
    // turning on the spot: about a point behind its middle, so the front swings round and the hind
    // end mostly stays put (as a llama turns — not a turntable spin); blends out as it gets going
    const pv = PIVOT_BACK * (1 - smooth(0.2, 1.2, speed)) * (FIXED_SPEED === null && !fall ? 1 : 0);
    if (pv > 0 && heading !== h0) {
      llama.position.x += -pv * (Math.cos(h0) - Math.cos(heading));
      llama.position.z -= -pv * (Math.sin(h0) - Math.sin(heading));
    }
    llama.position.x += Math.cos(heading) * speed * dt;
    _prev.copy(llama.position);
    llama.position.z -= Math.sin(heading) * speed * dt;
    if (self.climbs) {                                   // ramp: follow its surface
      keepOnWalkable(llama.position, _prev, heading, [HIP_FX, HIP_HX]);
      llama.position.y = groundHeight(llama.position.x, llama.position.z);
      // Legs stay plumb, and the body leans with the ground under the shoulders vs the hips, so
      // each shoulder/hip rides its usual height above the ground beneath it: the legs then walk
      // just like on the flat. (The neck is kept upright separately, so it doesn't look like
      // it's clinging to the slope.)
      const c = Math.cos(heading), sn = Math.sin(heading), p = llama.position, span = HIP_FX - HIP_HX;
      const gF = climbHeight(p.x + HIP_FX * c, p.z - HIP_FX * sn, p) - p.y;
      const gH = climbHeight(p.x + HIP_HX * c, p.z - HIP_HX * sn, p) - p.y;
      const lean = Math.atan2(gF - gH, span);
      tilt = damp(tilt, lean, 10, dt);
      lift = damp(lift, ((gF - HIP_FX * Math.sin(lean)) + (gH - HIP_HX * Math.sin(lean))) / 2, 10, dt);
    } else keepOffRamp(llama.position, heading, [0, HIP_FX, HIP_HX, HEAD_X]); // ramp: solid to the rest

    // --- gait blend: walk → pace → gallop (weights smoothed so transitions never pop) ---
    wPace = damp(wPace, smooth(2.6, 4.6, speed), 3, dt);
    wGallop = damp(wGallop, smooth(7.5, 10.5, speed), 3, dt);
    const mix = (k) => lerp(lerp(GAITS.walk[k], GAITS.pace[k], wPace), GAITS.gallop[k], wGallop);
    const duty = mix('duty'), liftF = mix('liftF'), liftH = mix('liftH');

    // --- cadence & stride: stride is derived from speed, so feet never slide and
    //     shrink smoothly back to the standing spot as the llama slows down ---
    const stepInPlace = smooth(0.15, 0.7, Math.abs(omega)) * (1 - smooth(0.3, 1.5, speed));
    let freq = speed > 0.02 || stepInPlace > 0.02 ? Math.max(F_MIN, mix('cadence') * (speed / mix('ref')) ** 0.4) : 0;
    let stride = freq > 0 ? speed * duty / freq : 0;
    if (stride > MAX_STRIDE) { stride = MAX_STRIDE; freq = speed * duty / MAX_STRIDE; }
    phase = (phase + dt * freq) % 1;
    const stepLift = Math.max(smooth(0, 0.8, stride), stepInPlace * 0.6);
    const tp = lerp(0.42, 0.32, wGallop); // lift peaks earlier when galloping

    for (const [key, leg] of legList) {
      const td = lerp(lerp(GAITS.walk.td[key], GAITS.pace.td[key], wPace), GAITS.gallop.td[key], wGallop);
      const p = ((phase - td) % 1 + 1) % 1;
      // a foot lands when its phase wraps round
      const landed = p < (leg.pLast ?? p) - 0.5 && stepLift > 0.25 && kushT === 0 && hopT < 0;
      if (mine && leg.front && landed) sfx.step(llama.position, llama.position.y); // sfx: a note per front foot
      leg.pLast = p;
      const f = footPath(p, duty, stride, (leg.front ? liftF : liftH) * stepLift, tp);
      leg.fx = leg.footX + f.x;
      if (landed) paintStep(self, llama.position, heading, leg.fx, leg.hip.z); // paint: footprints
      leg.fy = FOOT_Y + f.y;
      const lead = footPath((p + (leg.front ? LEAD.front : LEAD.hind)) % 1, duty, stride, 0, tp);
      leg.jx = lead.x * (leg.front ? PROTRACT.front : PROTRACT.hind);
    }

    // --- body: bob, bounce, pitch, roll ---
    const cyc = phase * Math.PI * 2;
    const move = smooth(0.05, 0.8, speed);
    const walkW = (1 - wPace) * move, paceW = wPace * (1 - wGallop) * move;
    // walk: vault over the stance legs (highest at mid-stance, twice per cycle)
    const bob = walkW * 0.05 * Math.cos(2 * (cyc - 0.34 * Math.PI * 2)) + paceW * 0.06 * Math.cos(cyc * 2);
    // gallop: airborne & gathered at ~0.93 → body peaks there; nose rises on hind push-off, dips on front landing
    const bounce = wGallop * 0.32 * (0.5 + 0.5 * Math.cos(cyc - 0.93 * Math.PI * 2));
    const pitch = wGallop * 0.06 * Math.sin(cyc - 0.05 * Math.PI * 2);
    // pace sways toward the stance side; every gait banks gently into turns
    const idleW = FIXED_SPEED === null ? Math.max(smooth(LOOK_AFTER, LOOK_AFTER + 1, brain.idle()), fF) * (1 - move) : 0;
    const roll = paceW * 0.06 * Math.sin(cyc) - clamp(omega * speed * 0.012, -0.09, 0.09)
      + idleW * (1 - fF) * 0.025 * Math.sin(time * 0.55); // idle: slow weight shift side to side
    const lean = clamp((vTarget - speed) * -0.004, -0.03, 0.03); // lean back when braking, forward when accelerating
    // ears flop a beat behind each step (walk and pace)
    earFlop = EAR_FLOP * move * (1 - wGallop) * Math.cos(2 * (cyc - lerp(0.34, 0, wPace) * Math.PI * 2) - 0.9);
    yS = damp(yS, RIG_Y - mix('drop') * move + bob + bounce, 20, dt);
    pitchS = damp(pitchS, pitch + lean, 12, dt);
    rollS = damp(rollS, roll, 6, dt);
    // hop (startle): body springs up, feet leave the ground a little less so the legs tuck
    let hopY = 0;
    if (hopT >= 0) {
      if (mine && hopT < 0.12 && hopT + dt >= 0.12) sfx.hop(llama.position); // sfx: take-off
      if (hopT < 0.5 && hopT + dt >= 0.5) puff(llama.position.x, llama.position.y, llama.position.z, hopBig > 1 ? 7 : 5); // dust: lands
      hopT += dt; hopY = hopCurve(hopT) * hopBig; if (hopT > 0.68) hopT = -1;
    }
    hopY += danceY;
    // intro: dropped in — falls straight down, stiff-legged, then a hard squash on landing
    let dropY = 0;
    if (camLook > 0) camLook -= dt;
    if (dropT >= 0) {
      const land = Math.sqrt(2 * DROP_H / DROP_G), u = (dropT += dt) - land;
      if (u < 0) dropY = DROP_H - 0.5 * DROP_G * dropT * dropT;
      else {
        if (u < dt) { camLook = 2.4; puff(llama.position.x, llama.position.y, llama.position.z, 12, { v: 3 }); sfx.land(llama.position); } // dust:, sfx:
        hopY -= 0.45 * (u < 0.05 ? smooth(0, 1, u / 0.05) : 1 - smooth(0, 1, (u - 0.05) / 0.3));
        if (u > 0.35) dropT = -1;
      }
    }
    const wiggle = dance ? Math.sin(dance.t * 16) * smooth(PRONK * 3 - 0.2, PRONK * 3, dance.t) * (1 - smooth(DANCE_LEN - 0.3, DANCE_LEN, dance.t)) : 0;
    rig.position.y = yS + hopY + dropY + lift;
    const shake = shakeT >= 0 ? Math.sin(shakeT * 38) * 0.16 * (1 - shakeT / 0.9) : 0; // rain: the shake-off
    const wobble = (fall ? 0 : weak) * (0.13 * Math.sin(time * 1.3) + 0.05 * Math.sin(time * 3.1)); // blight: unsteady, leaning side to side
    rig.rotation.set(rollS + wiggle * 0.08 + shake + wobble, 0, pitchS + tilt + Math.max(0, hopY) * (dance ? 0.03 : 0.08));
    // a single hop tucks the legs; pronking keeps them stiff (feet leave the ground with the body)
    if (hopY > 0) for (const [, leg] of legList) leg.fy += hopY * (dance ? 1 : 0.8);
    if (dropY > 0) for (const [, leg] of legList) leg.fy += dropY;   // intro: legs hang straight as it falls

    // kush: lying down folds the front first, then the hind; getting up raises the hind first
    const tF = kushDir >= 0 ? smoother(seg(kushT, 0, 0.6)) : smoother(seg(kushT, 0, 0.7));
    const tH = kushDir >= 0 ? smoother(seg(kushT, 0.25, 0.95)) : smoother(seg(kushT, 0.45, 1));
    fF = damp(fF, tF, 10, dt);
    fH = damp(fH, tH, 10, dt);
    if (fF > 1e-4 || fH > 1e-4) {
      const HFX = legs.LF.hip.x, HHX = legs.LH.hip.x, span = HFX - HHX;
      const p0 = rig.rotation.z;
      const hF = lerp(rig.position.y + HIP_Y + Math.sin(p0) * HFX, KUSH_HIP_Y, fF);
      const hH = lerp(rig.position.y + HIP_Y + Math.sin(p0) * HHX, KUSH_HIP_Y, fH);
      rig.rotation.z = Math.atan2(hF - hH, span);
      rig.position.y = (hH * HFX - hF * HHX) / span - HIP_Y;
      for (const [, leg] of legList) {
        const f = leg.front ? fF : fH;
        leg.fx = lerp(leg.fx, leg.hip.x + (leg.front ? KUSH_FOOT.front : KUSH_FOOT.hind), f);
        leg.fy = lerp(leg.fy, FOOT_Y, f);
      }
    }
    // kick: a keyframed front-foot path (llama-local), with a little body English
    if (act) {
      const t = act.t;
      const key = (frames) => { // [[time, x, y], ...] → eased interpolation
        if (t <= frames[0][0]) return frames[0].slice(1);
        for (let k = 1; k < frames.length; k++) if (t <= frames[k][0]) {
          const [ta, xa, ya] = frames[k - 1], [tb, xb, yb] = frames[k], u = smoother((t - ta) / (tb - ta));
          return [lerp(xa, xb, u), lerp(ya, yb, u)];
        }
        return frames[frames.length - 1].slice(1);
      };
      const fx0 = legs.LF.footX, Y = FOOT_Y;
      const leg = act.side > 0 ? legs.LF : legs.RF;
      const [x, y] = key([[0, fx0, Y], [0.3, fx0 - 0.7, Y + 0.7], [0.4, act.bx - 0.3, Y + 0.3], [0.52, act.bx + 0.5, Y + 1.0], [1.05, fx0, Y]]);
      leg.fx = x; leg.fy = y;
      rig.rotation.z += 0.06 * smooth(0, 0.3, t) * (1 - smooth(0.3, 0.45, t)) - 0.04 * smooth(0.35, 0.45, t) * (1 - smooth(0.6, 1.0, t));
    }
    // blight: keeling over — it stops and sways, harder and harder, then tips onto its side from the
    // edge of its hooves (legs going stiff), lands with a soft thud, and lies there, eyes X X.
    // Getting back up (blight switched off) is the tip in reverse.
    let dead = 0;
    if (fall) {
      const t = fall.up ? KEEL_SWAY + KEEL_TIP : (fall.t += dt);
      if (fall.up) fall.k = Math.max(0, fall.k - dt / 1.1);
      else if (t > KEEL_SWAY) {
        if (!fall.side) fall.side = keelSide();
        const u = (t - KEEL_SWAY) / KEEL_TIP;
        if (u >= 1 && fall.k < 1) {                 // lands: dust where its body hits, and a soft thud
          const sz = fall.side * 3.5;
          puff(llama.position.x + Math.sin(heading) * sz, 0, llama.position.z + Math.cos(heading) * sz, 10, { spread: 2.2 }); // dust:
          sfx.keel(llama.position);                   // sfx:
        }
        fall.k = u < 1 ? u * u : 1;                 // falls like a weight: slow, then fast
      }
      const settle = !fall.up && t > KEEL_SWAY + KEEL_TIP ? Math.sin(Math.min(1, (t - KEEL_SWAY - KEEL_TIP) / 0.3) * Math.PI) * 0.07 : 0; // a small rebound
      const k = fall.up ? smoother(fall.k) : fall.k;
      dead = fall.up ? 0 : smooth(KEEL_SWAY + KEEL_TIP - 0.05, KEEL_SWAY + KEEL_TIP, t);
      if (!fall.up) rig.rotation.x += (Math.sin(t * 4.2) * 0.14 + Math.sin(t * 9.5) * 0.04) * smooth(0, KEEL_SWAY, t) * (1 - k); // the sway before it goes
      const a = (Math.PI / 2 + KEEL_OVER) * (k - settle), th = (fall.side || 1) * a, pz = (fall.side || 1) * KEEL_EDGE;
      tipG.rotation.x = th;
      // pivot on the edge of the hooves; past its side, lifted so the body still rests on the ground
      const rest = Math.max(0, KEEL_EDGE - (RIG_Y * Math.cos(a) + KEEL_EDGE * Math.sin(a)));
      // lying there, it counts as being where its body is (so the others walk round the body, not the
      // hooves): the llama's own spot moves under it, the pivot moves back by the same amount
      const shift = !fall.up && dead >= 1 ? fall.side * KEEL_BODY : 0;
      if (shift !== fall.shift) {
        const d = shift - fall.shift;
        llama.position.x += Math.sin(heading) * d; llama.position.z += Math.cos(heading) * d;
        fall.shift = shift;
      }
      tipG.position.set(0, pz * Math.sin(th) + rest, pz * (1 - Math.cos(th)) - fall.shift);
      if (jolt) {                                    // clicked: a little hop and shift, a wobble, and down again
        const u = Math.min(1, (jolt.t += dt) / 0.38), e = smoother(u);
        tipG.position.y += 0.7 * 4 * u * (1 - u);
        tipG.rotation.x += Math.sin(u * Math.PI * 2) * 0.09 * (1 - u);
        llama.position.x += jolt.dx * (e - jolt.done); llama.position.z += jolt.dz * (e - jolt.done); jolt.done = e;
        if (u >= 1) { puff(llama.position.x, 0, llama.position.z, 6, { spread: 2 }); jolt = null; } // dust:
      }
      const stiff = fall.up ? k : smooth(0, 1, (t - KEEL_SWAY) / KEEL_TIP);
      for (const [, leg] of legList) {               // legs go straight and stiff, a little splayed
        leg.fx = lerp(leg.fx, leg.hip.x + (leg.front ? 0.7 : -0.8), stiff);
        leg.fy = lerp(leg.fy, rig.position.y + HIP_Y - (leg.L1 + leg.L2) * 0.97, stiff);
      }
      if (fall.up && fall.k === 0) { fall = null; tipG.rotation.x = 0; tipG.position.set(0, 0, 0); }
    }
    const alive = 1 - dead;
    const pitchA = rig.rotation.z, fold = Math.max(fF, fH);

    // breathing when idle
    body.scale.x = 1 + 0.012 * Math.sin(time * 1.7) * (1 - move) * alive;

    // --- neck & head ---
    // walk: gentle nod; gallop: the neck pumps forward and down as the front feet land, swings up while gathered
    const neckPump = wGallop * 0.16 * Math.cos(cyc - 0.82 * Math.PI * 2);
    // dance: the neck bobs with each bounce
    const danceNeck = dance ? -0.12 * Math.max(0, -danceY) + 0.06 * Math.max(0, danceY) : 0;
    neck.rotation.z = NECK_TILT - wGallop * 0.12 - neckPump - pitchA * lerp(0.4, 1, fold) + fold * 0.05 + danceNeck
      - tilt * 0.6                                        // ramp: keep the neck upright on a slope
      + Math.sin(cyc * 2) * (walkW * 0.035 + paceW * 0.02)
      - 0.22 * weak                                       // blight: head hangs
      - 0.28 * curious;                                   // blight: lowered, sniffing at a fallen one

    // idle: glance around at random; hovered: look at the viewer; dancing: bob side to side;
    // otherwise follow the cursor
    lookT -= dt;
    if (lookT < 0) { lookYaw = (Math.random() * 2 - 1) * 0.9; lookNod = Math.random() * 0.25 - 0.08; lookT = 1.2 + Math.random() * 2.3; }
    let yawWant = lerp(clamp(diff, -0.9, 0.9) * 0.6, lookYaw, idleW);
    if ((self.hovered || (camLook > 0 && camLook < 2.1)) && speed < 0.5) yawWant = clamp(wrap(CAM_HEADING - heading), -0.9, 0.9); // intro: the look after landing
    if (dance) yawWant = Math.sin(dance.t * 9) * 0.45;
    if (startleT > 0) yawWant = clamp(startleYaw, -0.9, 0.9);   // hit by a ball: look at where it came from
    if (act && act.t > 0.38) {                // follow the ball with the eyes
      const ball = loose.find((b) => b.tr === act.ball);
      if (ball) yawWant = clamp(wrap(Math.atan2(-(ball.tr.pos.z - llama.position.z), ball.tr.pos.x - llama.position.x) - heading), -0.9, 0.9);
    }
    yawWant += weak * 0.35 * Math.sin(time * 0.9);    // blight: head lolling
    const ins = brain.inspect, looking = !!ins && ins.near > 0;      // blight: curious, at a fallen one
    curious = damp(curious, looking ? 1 : 0, 3, dt);
    if (looking) { const o = ins.other.group.position; yawWant = clamp(wrap(Math.atan2(-(o.z - llama.position.z), o.x - llama.position.x) - heading), -0.9, 0.9); }
    if (fall) yawWant = 0;                             // blight: down, it doesn't look at anything
    yawLook = damp(yawLook, yawWant, dance ? 12 : 4, dt);
    nodS = damp(nodS, fall ? 0 : lookNod * idleW, 3, dt);
    head.rotation.z = -(neck.rotation.z + pitchA) * 0.8 + nodS;
    headYaw.rotation.y = yawLook;
    headYaw.rotation.x = petS * 0.3 + curious * 0.22;    // pet: head tilted, leaning into it (blight: a puzzled tilt)


    // tail: droops at rest, lifts when galloping or happy, wags while dancing
    tail.rotation.z = 0.55 - wGallop * 0.7 - perk * 0.35 + Math.sin(cyc * 2) * 0.06 * move + Math.sin(time * 1.1) * 0.03 * alive + 0.25 * weak; // blight: droops
    tail.rotation.y = dance ? Math.sin(dance.t * 20) * 0.5 : 0;

    // ears: flop back with speed, occasional idle twitch
    for (const [i, ear] of ears.entries()) {
      ear.next -= dt;
      if (ear.next < 0 && alive) { ear.twitch = 1; ear.next = 2 + Math.random() * 5; }
      ear.twitch = Math.max(0, ear.twitch - dt * 4);
      ear.g.rotation.z = 0.18 + wGallop * 0.45 + neckPump * 0.6 + Math.sin(time * 1.3 + i) * 0.04 * alive // (blight: the dead are still)
        + Math.sin(cyc * 2) * 0.05 * move + earFlop + Math.sin(ear.twitch * Math.PI) * 0.35
        // happy: ears perk forward and wiggle; dancing: they flap alternately
        - perk * 0.3 + perk * Math.sin(time * 28 + i * 2) * 0.12 + petS * 0.35 // pet: ears relax back
        + rainK * 0.3 + (shakeT >= 0 ? Math.sin(shakeT * 38 + i * 2) * 0.35 : 0) // rain: ears down; flapping in the shake
        + (dance ? Math.sin(dance.t * 14 + i * Math.PI) * 0.4 : 0)
        + 0.4 * weak;                                   // blight: ears down
    }

    // blink
    blinkT -= dt;
    const blink = blinkT < 0.12 && blinkT > 0 ? 0.1 : 1;
    if (blinkT < 0) blinkT = 2 + Math.random() * 4;
    for (const e of eyes) e.scale.set(alive, alive * blink * (1 - 0.45 * smile) * (1 - 0.88 * petS) * (1 - 0.45 * rainK) * (1 - 0.15 * weak), alive); // happy squint; pet: eyes closed; rain: a squint; blight: heavy-lidded
    xEyes.scale.setScalar(dead);                       // blight: X X

  }


  // ---------- pose legs (IK) for the current state ----------
  function poseLegs(dt) {
    const k = 1 - Math.exp(-40 * dt); // light joint smoothing (~25ms)
    const localZ = camDir.x * Math.sin(heading) + camDir.z * Math.cos(heading); // camera side, llama-local
    const pitch = rig.rotation.z, roll = rig.rotation.x;
    const cp = Math.cos(pitch), sp = Math.sin(pitch), sr = Math.sin(roll);
    for (const [, leg] of legList) {
      const hx = (leg.hip.x + leg.jx) * cp - leg.hip.y * sp;
      const hy = leg.hip.x * sp + leg.hip.y * cp + rig.position.y - leg.hip.z * sr;
      let fy = leg.fy;
      if (self.climbs && ramp) {                         // ramp: each foot stands on the ground under it
        const c = Math.cos(heading), s = Math.sin(heading), p = llama.position;
        fy += climbHeight(p.x + leg.fx * c + leg.hip.z * s, p.z - leg.fx * s + leg.hip.z * c, p) - p.y;
      }
      solveLeg(leg, hx, hy, leg.fx, fy, k);
      leg.color.lerpColors(colNear, colFar, clamp(0.5 - leg.side * localZ * 4, 0, 1));
    }
  }


  // on-screen box around the figure (for hover / poke)
  const _box = new THREE.Box3(), _corner = new THREE.Vector3();
  function screenRect() {
    _box.makeEmpty();
    _box.expandByObject(rig);
    for (const [, leg] of legList) _box.expandByObject(leg.root);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      _corner.set(i & 1 ? _box.max.x : _box.min.x, i & 2 ? _box.max.y : _box.min.y, i & 4 ? _box.max.z : _box.min.z).project(camera);
      const sx = (_corner.x * 0.5 + 0.5) * innerWidth, sy = (-_corner.y * 0.5 + 0.5) * innerHeight;
      x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
    }
    return { x0, y0, x1, y1 };
  }

  function setCoat(hex) {
    const c = coatFrom(hex);
    colNear.set(c.body);
    colFar.set(c.far);
    setEyes();
    baseNear.copy(colNear); baseFar.copy(colFar);   // blight:
    self.coat = c.body;
  }
  function dispose() {
    scene.remove(llama);
    for (const tr of balls) if (tr.claimedBy === id) tr.claimedBy = null;
  }

  Object.assign(self, {
    group: llama, head, parts, update, poseLegs, poke, bonk, screenRect, setCoat, dispose, coat: coat.body,
    pet(px) { if (!fall) pet = Math.min(1, pet + px / 250); }, // pet: px of gentle stroking
    keel(now) {                                          // blight: keel over (now: already lying there)
      if (fall && !fall.up) return;
      fallWant = true; brain.onPoke(); brain.endInspect?.(); // (wakes it from a nap first; forgets what it was looking at)
      if (now) { kushT = 0; kushDir = 0; fF = fH = 0; fallWant = false; heading = keelFace(); fall = { t: KEEL_SWAY + KEEL_TIP + 1, side: keelSide(), k: 1, up: false, shift: 0 }; }
    },
    inspect: (o) => brain.canInspect?.() && brain.startInspect(o),   // blight: go and look at a fallen one
    rise() { fallWant = false; if (fall) fall.up = true; }, // blight: get back up
    setFar(hex) { colFar.set(hex); baseFar.copy(colFar); }, // void: yours goes all black
    tip: tipG,                                           // piles: its body follows the tip
    shakeOff(delay) { shakeIn = delay; },               // rain: shake off after this many seconds
    canGreet: () => brain.canGreet?.() ?? false,         // greet: (wanderers only)
    canKick: () => !fall && !act && !pieceGoal && !self.followLeader && kushT === 0 && !dance && pet < 0.15, // piles:
    kickPiece(t) { pieceGoal = t; if (kushT > 0) kushDir = -1; },
    startGreet: (o, first) => brain.startGreet(o, first),
    drop() { dropT = 0; hopT = -1; if (mine) { brain.hold = SETTLE_HOLD; brain.since = 0; } }, // intro: appear in mid-air and fall (and settle)
    celebrate() { if (fall || fallWant || ill()) return; if (kushT > 0) kushDir = -1; dance = { t: 0 }; hopT = -1; }, // gather: finale dance (blight: not the dead)
  });
  // a live getter (Object.assign would only copy its value once)
  Object.defineProperty(self, 'phase', { get: () => phase });
  Object.defineProperty(self, 'fallen', { get: () => !!fall || fallWant }); // blight: down (or about to go)
  Object.defineProperty(self, 'dest', { get: () => brain.goal }); // where it's heading (or null)
  return self;
}

// ---------- personal space ----------
// The steering above keeps llamas apart most of the time, but up close (bunched together, herded,
// greeting, or a wanderer caught in your way) they could end up overlapping — necks through
// necks — or wedged against each other. So, after everyone has moved: each llama is a capsule along
// its body (tail to neck, seen from above), and any two that overlap are eased apart. Yours has
// right of way (it's never pushed by the living; it nudges them); the fallen don't move (the living,
// yours included, are moved off them).
const SPACE_BACK = 1.6, SPACE_FRONT = 2.4, SPACE_R = 1.1;  // the capsule: behind / ahead of centre, radius
const SPACE_PUSH = 30;                                   // fastest it eases them apart (units a second)
const _sa = [0, 0, 0, 0], _sb = [0, 0, 0, 0];
function spaceSeg(l, o) {                                // the capsule's two end points, from above
  const h = l.group.rotation.y, c = Math.cos(h), sn = Math.sin(h), p = l.group.position;
  o[0] = p.x - c * SPACE_BACK; o[1] = p.z + sn * SPACE_BACK; o[2] = p.x + c * SPACE_FRONT; o[3] = p.z - sn * SPACE_FRONT;
}
// closest points between segments a and b (2D): returns the gap, with the direction b → a in _sd
const _sd = [0, 0];
function segGap(a, b) {
  const dx = a[2] - a[0], dz = a[3] - a[1], ex = b[2] - b[0], ez = b[3] - b[1], rx = a[0] - b[0], rz = a[1] - b[1];
  const A = dx * dx + dz * dz, E = ex * ex + ez * ez, F = ex * rx + ez * rz, C = dx * rx + dz * rz, B = dx * ex + dz * ez;
  const den = A * E - B * B;
  let s = den > 1e-6 ? clamp((B * F - C * E) / den, 0, 1) : 0, t = (B * s + F) / E;
  if (t < 0) { t = 0; s = clamp(-C / A, 0, 1); } else if (t > 1) { t = 1; s = clamp((B - C) / A, 0, 1); }
  const px = a[0] + dx * s - (b[0] + ex * t), pz = a[1] + dz * s - (b[1] + ez * t), d = Math.hypot(px, pz);
  if (d > 1e-4) { _sd[0] = px / d; _sd[1] = pz / d; } else { _sd[0] = 1; _sd[1] = 0; }
  return d;
}
function personalSpace(dt) {
  if (FIXED_SPEED !== null) return;
  const max = SPACE_PUSH * dt;
  for (let i = 0; i < llamas.length; i++) for (let j = i + 1; j < llamas.length; j++) {
    const a = llamas[i], b = llamas[j];
    if (a.gone || b.gone) continue;                      // void: falling in
    const pa = a.group.position, pb = b.group.position;
    if (Math.abs(pa.x - pb.x) > 9 || Math.abs(pa.z - pb.z) > 9) continue;
    spaceSeg(a, _sa); spaceSeg(b, _sb);
    const gap = segGap(_sa, _sb), over = 2 * SPACE_R - gap;
    if (over <= 0) continue;
    if (gap < 0.3) {                                     // crossing: part them along the line between their centres
      const dx = pa.x - pb.x, dz = pa.z - pb.z, d = Math.hypot(dx, dz) || 1;
      _sd[0] = dx / d; _sd[1] = dz / d;
    }
    // how much each gives way: the fallen and (against the living) yours don't
    const wa = a.fallen ? 0 : a === player ? (b.fallen ? 1 : 0) : 1;
    const wb = b.fallen ? 0 : b === player ? (a.fallen ? 1 : 0) : 1;
    if (wa + wb === 0) continue;
    const m = Math.min(over, max) / (wa + wb);
    pa.x += _sd[0] * m * wa; pa.z += _sd[1] * m * wa;
    pb.x -= _sd[0] * m * wb; pb.z -= _sd[1] * m * wb;
  }
}

// ---------- the herd ----------
const START_HERD = 6;
const llamas = [createLlama({ id: 'you', coat: COATS.black, brain: 'cursor', heading: FIXED_SPEED !== null ? Math.atan2(camDir.x, camDir.z) : 0 })];
if (FIXED_SPEED !== null) hint.remove();
const player = llamas[0];

// ---------- control panel ----------
const MAX_LLAMAS = 12;
let llamaCount = llamas.length;
const $ = (sel) => document.querySelector(sel);
const panel = $('#panel'), toggle = $('#panel-toggle');
if (!CONTROLS) toggle.hidden = panel.hidden = true;
const zoomIn = $('#zoom'), orbitIn = $('#orbit'), tiltIn = $('#tilt'), bgIn = $('#bg');
const hex = (n) => '#' + n.toString(16).padStart(6, '0');

function setZoom(z) {
  z = clamp(z, +zoomIn.min, +zoomIn.max);
  zoomIn.value = z;
  VIEW = BASE_VIEW / z;
  resize();
}
zoomIn.value = BASE_VIEW / VIEW;
orbitIn.value = camOrbit;
tiltIn.value = camTilt;
zoomIn.addEventListener('input', () => setZoom(+zoomIn.value));
orbitIn.addEventListener('input', () => { camOrbit = +orbitIn.value; placeCamera(); });
tiltIn.addEventListener('input', () => { camTilt = +tiltIn.value; placeCamera(); });
const soundIn = $('#sound'), tuneIn = $('#tune');             // sfx: on/off, tune picker
if (!SFX) $('#sound-row').remove();
for (const [k, tn] of Object.entries(TUNES)) tuneIn.add(new Option(tn.name, k, false, tn === tune));
tuneIn.addEventListener('change', () => {
  tune = TUNES[tuneIn.value];
  try { localStorage.setItem('llama-tune', tuneIn.value); } catch {}
  sfxStart();
  sfx.party(player.group.position);                             // a little preview
});
const musicIn = $('#music');                                   // music: on/off
if (!MUSIC) $('#music-row').remove();
musicIn.checked = musicOn;
musicIn.addEventListener('change', () => {
  musicOn = musicIn.checked;
  try { localStorage.setItem('llama-music', musicOn ? 'on' : 'off'); } catch {}
  if (musicOn) sfxStart();
});
soundIn.addEventListener('change', () => {
  sfxOn = soundIn.checked;
  if (sfxOn) sfxStart(); else actx?.suspend();
});
bgIn.addEventListener('input', () => { renderer.setClearColor(bgIn.value); document.body.style.background = bgIn.value; });
// mouse wheel / trackpad pinch zooms too
// Trackpad: pinch zooms, two fingers sideways orbits, up and down tilts. A mouse wheel zooms — told
// apart by its whole-notch steps (once trackpad-style scrolling has been seen, it's taken as a
// trackpad from then on). Holding ⌥ Option, up and down always tilts (if a wheel is ever misread).
let trackpadSeen = false;
const isMouseWheel = (e) => {
  if (e.deltaMode !== 0) return true;                            // lines or pages: a wheel (Firefox)
  if (!Number.isInteger(e.deltaY) || (e.deltaX && Math.abs(e.deltaX) < Math.abs(e.deltaY))) trackpadSeen = true; // fractional or diagonal: fingers
  return !trackpadSeen && e.wheelDeltaY !== undefined && e.wheelDeltaY !== 0 && e.wheelDeltaY % 120 === 0;
};
renderer.domElement.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey) { setZoom(+zoomIn.value * Math.exp(-e.deltaY * 0.01)); return; }   // a pinch (browsers flag it as ctrl)
  if (e.altKey) { setTilt(camTilt - (e.deltaY || e.deltaX) * TILT_SWIPE); return; }  // ⌥ + up/down: tilt, always
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) setOrbit(camOrbit + e.deltaX * ORBIT_SWIPE);
  else if (isMouseWheel(e)) setZoom(+zoomIn.value * Math.exp(-e.deltaY * 0.0015));
  else setTilt(camTilt - e.deltaY * TILT_SWIPE);                // (fingers down: look down from higher up, as right-drag does)
}, { passive: false });
// right-drag turns the camera too — sideways orbits, up and down tilts (right-click isn't used for
// anything else, so it can't clash with dropping balls, herding or petting). While dragging, your
// llama ignores the cursor.
const ORBIT_DRAG = 0.3, ORBIT_SWIPE = 0.12;   // degrees per pixel dragged / per unit swiped
const TILT_SWIPE = 0.12;                       // degrees of tilt per unit swiped up or down
function setOrbit(deg) {
  camOrbit = ((deg + 180) % 360 + 360) % 360 - 180;
  orbitIn.value = camOrbit;
  placeCamera();
}
function setTilt(deg) {                       // (kept within the panel slider's range)
  camTilt = clamp(deg, +tiltIn.min, +tiltIn.max);
  tiltIn.value = camTilt;
  placeCamera();
}
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 2) return;
  orbitDrag = { x: e.clientX, y: e.clientY };
  homing = null;                               // (intro: your hand takes over from the glide home)
  renderer.domElement.setPointerCapture(e.pointerId);
});
addEventListener('pointermove', (e) => {
  if (!orbitDrag) return;
  setOrbit(camOrbit - (e.clientX - orbitDrag.x) * ORBIT_DRAG);
  setTilt(camTilt + (e.clientY - orbitDrag.y) * ORBIT_DRAG);   // drag down: look down from higher up
  orbitDrag.x = e.clientX; orbitDrag.y = e.clientY;
});
addEventListener('pointerup', (e) => { if (e.button === 2) orbitDrag = null; });

toggle.addEventListener('click', () => { panel.classList.add('open'); toggle.style.display = 'none'; });
$('#panel .close').addEventListener('click', () => { panel.classList.remove('open'); toggle.style.display = ''; });

function renderLlamaList() {
  const list = $('#llama-list');
  list.innerHTML = '';
  for (const l of llamas) {
    const row = document.createElement('div');
    row.className = 'row llama-row';
    const pick = document.createElement('input');
    pick.type = 'color';
    pick.value = hex(l.coat);
    pick.addEventListener('input', () => l.setCoat(pick.value));
    const name = document.createElement('span');
    name.textContent = l === player ? 'You' : l.name;
    row.append(pick, name);
    list.append(row);
  }
  $('#add-llama').disabled = llamas.length >= MAX_LLAMAS;
  $('#remove-llama').disabled = llamas.length <= 1;
}
// named after iconic chairs, shuffled each visit; a new llama takes the first name not in use
const NAMES = ['Wishbone', 'Panton', 'Hoffmann', 'Fritz', 'Gropius', 'Bertoia', 'Eames', 'Wassily', 'Barcelona',
  'Tulip', 'Thonet', 'Cesca', 'Aalto', 'Saarinen', 'Jacobsen', 'Breuer', 'Prouvé', 'Egg'].sort(() => Math.random() - 0.5);

const _spawn = new THREE.Vector3();
function addLlama() {
  if (llamas.length >= MAX_LLAMAS) return;
  // spawn on visible ground, as far from the others as a few tries allow
  let best = null, bestGap = -1;
  for (let i = 0; i < 12; i++) {
    randomGroundPoint(_spawn, player.group.position, 0);
    const gap = Math.min(...llamas.map((l) => Math.hypot(l.group.position.x - _spawn.x, l.group.position.z - _spawn.z)))
      - (onRamp(_spawn.x, _spawn.z, 5) ? 100 : 0);         // ramp: never spawn on it
    if (gap > bestGap) { bestGap = gap; best = _spawn.clone(); }
  }
  const used = new Set(llamas.map((l) => l.coat));
  const coat = COAT_CHOICES.find((c) => !used.has(c)) ?? COAT_CHOICES[Math.floor(Math.random() * COAT_CHOICES.length)];
  const l = createLlama({ id: 'llama-' + (llamaCount++), coat: coatFrom(coat), brain: 'wander', x: best.x, z: best.z, heading: Math.random() * Math.PI * 2 });
  const taken = new Set(llamas.map((o) => o.name));
  l.name = NAMES.find((n) => !taken.has(n)) ?? NAMES[llamaCount % NAMES.length];
  llamas.push(l);
  renderLlamaList();
}
$('#add-llama').addEventListener('click', addLlama);
$('#remove-llama').addEventListener('click', () => {
  if (llamas.length <= 1) return;
  llamas.pop().dispose();
  renderLlamaList();
});
if (FIXED_SPEED === null) while (llamas.length < START_HERD) addLlama();
renderLlamaList();
if (FIXED_SPEED !== null) toggle.remove();

function followCamera() {
  if (FIXED_SPEED === null) return;
  const p = player.group.position;
  camera.position.set(p.x + CAM_OFFSET.x, CAM_OFFSET.y + 3.5, p.z + CAM_OFFSET.z);
  camera.lookAt(p.x, 3.5, p.z);
}

// ---------- paint (decoration) ----------
// A splat of paint somewhere on the ground. A llama that steps in it picks some up and leaves a
// short trail of footprints, fainter and smaller as the paint runs out; each print fades away
// within a couple of seconds, so nothing builds up.
// To remove: set PAINT = false (or delete this section and the small hooks marked "paint:").
const PAINT = FIXED_SPEED === null;
const PAINT_COLS = [0xf0a29e, 0xf6d2b2, 0xc3c8aa, 0x86ad96]; // the herd palette minus coral (reads as blood): blush, peach, sage, green
const PRINT_STEPS = 16;    // footprints from one dip in the paint (four feet: about four strides)
const PRINT_LIFE = 2.5;    // seconds each print lasts
const PRINT_CAP = 300;
const STREAK_LEN = 18;     // how far a ball that rolled through the paint keeps leaving a streak
let paint = null;          // { blobs: [[x, z, r]], color, prints: InstancedMesh, list }
if (PAINT) {
  // somewhere in view, clear of the ramp and of your llama
  const c = new THREE.Vector3();
  for (let i = 0; i < 30; i++) {
    randomGroundPoint(c, player.group.position, 10);
    if (!onRamp(c.x, c.z, 8)) break;
  }
  // a few overlapping lobes and some droplets, merged into one flat shape
  const color = new THREE.Color(PAINT_COLS[Math.floor(Math.random() * PAINT_COLS.length)]);
  const blobs = [[0, 0, 3]], geos = [];
  for (let i = 0; i < 4; i++) {
    const a = (i + Math.random() * 0.6) * Math.PI / 2, d = 1.7 + Math.random() * 1.1;
    blobs.push([Math.cos(a) * d, Math.sin(a) * d, 1.5 + Math.random() * 0.8]);
  }
  const drops = [];
  for (let i = 0; i < 4; i++) {
    const a = Math.random() * Math.PI * 2, d = 4.6 + Math.random() * 1.8;
    drops.push([Math.cos(a) * d, Math.sin(a) * d, 0.3 + Math.random() * 0.35]);
  }
  for (const [x, z, r] of [...blobs, ...drops]) geos.push(new THREE.CircleGeometry(r, 28).rotateX(-Math.PI / 2).translate(x, 0, z));
  // drawn flat on the ground without writing depth, so the llamas' shadows still fall across it
  const blob = new THREE.Mesh(mergeGeometries(geos), new THREE.MeshBasicMaterial({ color, depthWrite: false }));
  blob.position.set(c.x, 0.01, c.z);
  blob.renderOrder = -2;
  scene.add(blob);
  const prints = new THREE.InstancedMesh(new THREE.CircleGeometry(0.55, 16).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ depthWrite: false }), PRINT_CAP);
  prints.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(PRINT_CAP * 3), 3);
  prints.frustumCulled = false;
  prints.renderOrder = -1;
  prints.count = 0;
  scene.add(prints);
  paint = { blobs: blobs.map(([x, z, r]) => [c.x + x, c.z + z, r]), color, prints, list: [], blob }; // (void: blob sinks)
}
const inPaint = (x, z) => paint.blobs.some(([bx, bz, r]) => Math.hypot(x - bx, z - bz) < r);
// a foot has landed at body-space (fx, hz): dip it, or leave a print if it's carrying paint
function paintStep(l, pos, heading, fx, hz) {
  if (!paint || pos.y > 0.05) return;                 // not on the ramp
  const c = Math.cos(heading), s = Math.sin(heading);
  const x = pos.x + fx * c + hz * s, z = pos.z - fx * s + hz * c;
  if (l === player && blight >= BLIGHT_PRINTS && !vd.on) {  // blight: yours leaves black prints (until the void opens)
    paint.list.push({ x, z, heading, k: 1, t: 0, col: _blackPrint, life: BLIGHT_PRINT_LIFE });
    if (paint.list.length > PRINT_CAP) paint.list.shift();
    return;
  }
  if (inPaint(x, z)) { l.paint = PRINT_STEPS; return; }
  if (!(l.paint > 0)) return;
  paint.list.push({ x, z, heading, k: l.paint / PRINT_STEPS, t: 0 });
  if (paint.list.length > PRINT_CAP) paint.list.shift();
  l.paint--;
}
// a rolling ball: dipped in the paint, it leaves a smear of overlapping dots, thinning as it runs out
function paintStreak(b, pos) {
  if (!paint) return;
  if (inPaint(pos.x, pos.z)) { b.paint = STREAK_LEN; b.lastDot = null; return; }
  if (!(b.paint > 0)) return;
  const d = b.lastDot ? Math.hypot(pos.x - b.lastDot.x, pos.z - b.lastDot.z) : 1;
  if (d < 0.3) return;
  b.paint -= d;
  paint.list.push({ x: pos.x, z: pos.z, heading: Math.atan2(-b.vz, b.vx), k: Math.max(0, b.paint) / STREAK_LEN, t: 0, sx: 1, sz: 0.75 });
  if (paint.list.length > PRINT_CAP) paint.list.shift();
  b.lastDot = { x: pos.x, z: pos.z };
}
const _pm = new THREE.Matrix4(), _pq = new THREE.Quaternion(), _pp = new THREE.Vector3(), _ps = new THREE.Vector3();
const _pY = new THREE.Vector3(0, 1, 0), _pc = new THREE.Color(), _bgc = new THREE.Color();
// prints shrink a little and melt into the ground colour toward the end of their life
function updatePaint(dt) {
  if (!paint) return;
  const list = paint.list, mesh = paint.prints;
  while (list.length && list[0].t > (list[0].life ?? PRINT_LIFE)) list.shift();
  renderer.getClearColor(_bgc);
  list.forEach((pr, i) => {
    pr.t += dt;
    const fade = smooth(0.3, 1, pr.t / (pr.life ?? PRINT_LIFE)), size = (0.6 + 0.4 * pr.k) * (1 - 0.4 * fade);
    _pm.compose(_pp.set(pr.x, 0.015, pr.z), _pq.setFromAxisAngle(_pY, pr.heading), _ps.set((pr.sx ?? 1.2) * size, 1, (pr.sz ?? 0.85) * size));
    mesh.setMatrixAt(i, _pm);
    mesh.setColorAt(i, _pc.copy(pr.col ?? paint.color).lerp(_bgc, fade));
  });
  mesh.count = list.length;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
}

// ---------- piles (physics) ----------
// A couple of toy-block stacks — blocks, balls, a stick and a party-hat cone — built from real
// physics (cannon-es). Any llama walking into one topples it; after that the pieces just get
// nudged about and spread around by whoever passes. They never tidy themselves back up.
// Kicked balls knock them too. Each llama is an invisible solid box (body and legs, plus one for
// the neck and head) that moves with it; resting pieces sleep, so a settled pile costs nothing.
// To remove: set PILES = false (or delete this section, the cannon-es import/import-map line and
// the small hooks marked "piles:").
const PILES = FIXED_SPEED === null;
const PILE_COUNT = 2;
const PILE_COLS = { peach: 0xf3d3b5, blush: 0xe6a39e, sage: 0xc3c8aa, stick: 0xefc59a };
const PILE_GRAVITY = 40;   // (the world is big: a stronger pull keeps falls from looking floaty)
const PILE_SHOVE = 7;      // the most a llama passes on when it walks into a piece (so a gallop nudges, not flings)
let piles = null;          // { world, pieces: [{ body, mesh, kind }], llamaBodies: Map, ballBodies: Map }
if (PILES) {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -PILE_GRAVITY, 0) });
  world.allowSleep = true;
  world.defaultContactMaterial.friction = 0.5;
  world.defaultContactMaterial.restitution = 0.08;
  const floor = new CANNON.Body({ type: CANNON.Body.STATIC, shape: new CANNON.Plane() });
  floor.quaternion.setFromEuler(-Math.PI / 2, 0, 0);       // (a plane faces +z; turn it to face up)
  world.addBody(floor);
  // ramp: solid too — its flat top, and a slab along the slope
  if (ramp) {
    const x0 = -RAMP_LEN / 2, a = Math.atan2(RAMP_H, RAMP_SLOPE), len = Math.hypot(RAMP_SLOPE, RAMP_H), t = 1;
    const body = new CANNON.Body({ type: CANNON.Body.STATIC });
    body.addShape(new CANNON.Box(new CANNON.Vec3(RAMP_TOP / 2, RAMP_H / 2, RAMP_W / 2)), new CANNON.Vec3(RAMP_LEN / 2 - RAMP_TOP / 2, RAMP_H / 2, 0));
    body.addShape(new CANNON.Box(new CANNON.Vec3(len / 2, t / 2, RAMP_W / 2)),
      new CANNON.Vec3(x0 + RAMP_SLOPE / 2 + Math.sin(a) * t / 2, RAMP_H / 2 - Math.cos(a) * t / 2, 0),
      new CANNON.Quaternion().setFromEuler(0, 0, a));
    body.position.set(ramp.x, 0, ramp.z);
    body.quaternion.setFromEuler(0, ramp.rot, 0);
    world.addBody(body);
  }
  piles = { world, pieces: [], llamaBodies: new Map(), ballBodies: new Map(), heard: 0, targets: [], fallen: [] };
  // llamas push without any bounce
  const pieceMat = new CANNON.Material('piece'), shoveMat = piles.shoveMat = new CANNON.Material('llama');
  world.addContactMaterial(new CANNON.ContactMaterial(pieceMat, shoveMat, { friction: 0.3, restitution: 0 }));
  // where: in view, clear of the ramp (and the run-up to its slope) and the paint, apart from each other
  const spots = [], p = new THREE.Vector3(), v = new THREE.Vector3();
  const rampClear = (x, z) => !ramp || (!onRamp(x, z, 9) && !((([lx, lz]) => lx < -RAMP_LEN / 2 && lx > -RAMP_LEN / 2 - 24 && Math.abs(lz) < RAMP_W / 2 + 7)(rampLocal(x, z))));
  for (let i = 0; i < 400 && spots.length < PILE_COUNT; i++) {
    randomGroundPoint(p, { x: 0, z: 0 }, 12);
    if (!rampClear(p.x, p.z)) continue;
    if (paint && paint.blobs.some(([bx, bz, r]) => Math.hypot(p.x - bx, p.z - bz) < r + 7)) continue;
    if (spots.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 22)) continue;
    v.set(p.x, 6, p.z).project(camera);
    if (Math.abs(v.x) > 0.8 || Math.abs(v.y) > 0.8) continue;
    spots.push(p.clone());
  }
  // the pieces: [kind, local x, y, z, size, colour]; the stack is turned to a random angle
  const PILE = [
    ['box', -1.0, 0.9, 0, 1.8], ['box', -1.0, 2.7, 0, 1.8], ['box', -1.0, 4.5, 0, 1.8], ['ball', -1.0, 6.35, 0, 0.95, 'peach'],
    ['box', 1.0, 0.9, 0.3, 1.8], ['ball', 0.95, 2.7, 0.3, 0.9, 'sage'], ['ball', 1.2, 0.9, -1.75, 0.9, 'sage'],
    ['cone', -2.7, 0.95, -0.9, 0.75], ['stick', 2.25, 1.55, 0.3, 0.24],
  ];
  // the cone's stripes
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64;
  const g = cv.getContext('2d'); g.fillStyle = '#e6a39e'; g.fillRect(0, 0, 64, 64); g.fillStyle = '#f3d3b5';
  for (let y = 4; y < 64; y += 16) g.fillRect(0, y, 64, 7);
  const coneTex = new THREE.CanvasTexture(cv); coneTex.colorSpace = THREE.SRGBColorSpace;
  const boxMats = [PILE_COLS.blush, PILE_COLS.peach, PILE_COLS.blush, PILE_COLS.blush, PILE_COLS.peach, PILE_COLS.blush].map(mat);
  for (const [pileIx, c] of spots.entries()) {
    const turn = Math.random() * Math.PI * 2, ct = Math.cos(turn), st = Math.sin(turn);
    for (const [kind, lx, ly, lz, size, col] of PILE) {
      let shape, geo, material, q = new CANNON.Quaternion();
      if (kind === 'box') { shape = new CANNON.Box(new CANNON.Vec3(size / 2, size / 2, size / 2)); geo = new THREE.BoxGeometry(size, size, size); material = boxMats; }
      else if (kind === 'ball') { shape = new CANNON.Sphere(size); geo = new THREE.SphereGeometry(size, 20, 14); material = mat(PILE_COLS[col]); }
      else if (kind === 'cone') { shape = new CANNON.Cylinder(0.02, size, 1.9, 16); geo = new THREE.ConeGeometry(size, 1.9, 24); material = new THREE.MeshBasicMaterial({ map: coneTex }); }
      else { shape = new CANNON.Cylinder(size, size, 2.9, 10); geo = new THREE.CapsuleGeometry(size, 2.9 - 2 * size, 4, 10); material = mat(PILE_COLS.stick); q.setFromEuler(0, 0, 0.62); }
      const body = new CANNON.Body({ mass: kind === 'stick' ? 0.4 : 1, shape, material: pieceMat,
        linearDamping: kind === 'ball' ? 0.45 : 0.3, angularDamping: kind === 'ball' ? 0.7 : 0.45 }); // (balls: don't roll off forever)
      body.sleepSpeedLimit = 0.4; body.sleepTimeLimit = 0.5;
      body.position.set(c.x + lx * ct + lz * st, ly, c.z - lx * st + lz * ct);
      const yaw = new CANNON.Quaternion().setFromEuler(0, turn, 0);
      body.quaternion.copy(yaw.mult(q));
      world.addBody(body);
      const mesh = new THREE.Mesh(geo, material);
      mesh.castShadow = true;
      scene.add(mesh);
      const piece = { body, mesh, kind, pile: pileIx };
      body.addEventListener('collide', (e) => pileKnock(piece, e));
      piles.pieces.push(piece);
    }
  }
  // let them settle into place before anyone sees them, then put them to sleep
  for (let i = 0; i < 120; i++) world.step(1 / 60);
  for (const q of piles.pieces) q.home = q.body.position.clone();
  piles.fallen = spots.map(() => false);
  for (const { body } of piles.pieces) body.sleep();
  syncPiles();
}
function syncPiles() {
  for (const { body, mesh } of piles.pieces) { mesh.position.copy(body.position); mesh.quaternion.copy(body.quaternion); }
}
// sfx: a soft wooden tok when a piece lands or knocks into something (not too many at once)
function pileKnock(piece, e) {
  const hit = Math.abs(e.contact.getImpactVelocityAlongNormal());
  if (hit < 2.5 || !actx) return;
  const now = performance.now();
  if (now - piles.heard < 45) return;
  piles.heard = now;
  sfx.knock(piece.mesh.position, piece.kind, Math.min(1, hit / 18));
}
const _pv = new CANNON.Vec3(), _pw = new THREE.Vector3(), _pwq = new THREE.Quaternion();
// each llama (and each flying ball) is a solid that moves with it, so it shoves pieces as it goes
function llamaBody(l) {
  let b = piles.llamaBodies.get(l);
  if (!b) {
    b = new CANNON.Body({ type: CANNON.Body.KINEMATIC, allowSleep: false, material: piles.shoveMat });   // (a sleeping one wouldn't shove)
    b.addShape(new CANNON.Box(new CANNON.Vec3(2.4, 2.0, 1.05)), new CANNON.Vec3(-0.2, 2.2, 0));   // body and legs
    b.addShape(new CANNON.Box(new CANNON.Vec3(0.75, 1.9, 0.65)), new CANNON.Vec3(2.4, 6.0, 0));   // neck and head
    piles.world.addBody(b);
    piles.llamaBodies.set(l, b);
  }
  return b;
}
function updatePiles(dt) {
  if (!piles || dt <= 0) return;
  for (const [l, b] of piles.llamaBodies) if (!llamas.includes(l)) { piles.world.removeBody(b); piles.llamaBodies.delete(l); }
  for (const l of llamas) {
    if (l.gone) {                                                   // void: swallowed — no longer solid
      const b = piles.llamaBodies.get(l);
      if (b) { piles.world.removeBody(b); piles.llamaBodies.delete(l); }
      continue;
    }
    const b = llamaBody(l), p = l.tip.getWorldPosition(_pw);       // (blight: a fallen one lies on its side)
    _pv.set(p.x, p.y, p.z);
    b.velocity.set((_pv.x - b.position.x) / dt, (_pv.y - b.position.y) / dt, (_pv.z - b.position.z) / dt);
    const sp = b.velocity.length();
    if (sp > 60) b.velocity.set(0, 0, 0);                                            // (a teleport, not a shove)
    else if (sp > PILE_SHOVE) b.velocity.scale(PILE_SHOVE / sp, b.velocity);        // gentle, even at a gallop
    b.position.copy(_pv);
    _pwq.setFromEuler(l.group.rotation).multiply(l.tip.quaternion); // (not from the world matrix: a shrinking llama's scale would spoil it)
    b.quaternion.set(_pwq.x, _pwq.y, _pwq.z, _pwq.w);
  }
  for (const [ball, b] of piles.ballBodies) if (!loose.includes(ball)) { piles.world.removeBody(b); piles.ballBodies.delete(ball); }
  for (const ball of loose) {
    let b = piles.ballBodies.get(ball);
    if (!b) { b = new CANNON.Body({ type: CANNON.Body.KINEMATIC, allowSleep: false, shape: new CANNON.Sphere(BALL_R) }); b.position.set(ball.tr.pos.x, ball.y, ball.tr.pos.z); piles.world.addBody(b); piles.ballBodies.set(ball, b); }
    b.velocity.set(ball.vx, ball.vy, ball.vz);
    b.position.set(ball.tr.pos.x, ball.y, ball.tr.pos.z);
  }
  piles.world.step(1 / 60, dt, 3);
  // a pile counts as knocked over once any of its pieces has moved off its spot
  for (const q of piles.pieces) if (!piles.fallen[q.pile] && q.body.position.distanceTo(q.home) > 0.6) piles.fallen[q.pile] = true;
  for (const t of piles.targets) t.pos.set(t.piece.body.position.x, 0, t.piece.body.position.z);
  syncPiles();
}

// Click (or tap) a piece from a knocked-over pile: either it gives a little pop into the air, or
// the nearest free llama ambles over and kicks it (half the time each; a pop if nobody's free).
const _pieceHit = [];
function pieceAt() {                                   // the clickable piece under the pointer (ray already set)
  if (!piles) return null;
  _pieceHit.length = 0;
  ray.intersectObjects(piles.pieces.map((q) => q.mesh), false, _pieceHit);
  const q = _pieceHit.length && piles.pieces.find((p) => p.mesh === _pieceHit[0].object);
  return q && piles.fallen[q.pile] ? q : null;
}
function popPiece(q) {
  const b = q.body;
  b.wakeUp();
  b.velocity.set((Math.random() - 0.5) * 5, 9 + Math.random() * 3, (Math.random() - 0.5) * 5);
  b.angularVelocity.set((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8);
  puff(b.position.x, 0, b.position.z, 5);              // dust:
  sfx.pop(q.mesh.position);
}
function kickPiece(q, heading) {                       // (from a llama's kick, at the moment its foot connects)
  const b = q.body, c = Math.cos(heading), s = Math.sin(heading);
  b.wakeUp();
  b.velocity.set(c * 12, 7, -s * 12);
  b.angularVelocity.set((Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10);
}
function tapPiece(q) {
  pointerIdle = 0;
  if (piles.targets.some((t) => t.piece === q)) return;          // someone's already on their way
  const free = llamas.filter((l) => l.canKick() && l.group.position.distanceTo(q.mesh.position) < 40);
  if (!free.length || Math.random() < 0.5) { popPiece(q); return; }
  const l = free.reduce((a, b) => (a.group.position.distanceTo(q.mesh.position) < b.group.position.distanceTo(q.mesh.position) ? a : b));
  const t = { piece: q, pos: new THREE.Vector3(q.body.position.x, 0, q.body.position.z), claimedBy: null, by: l, t: 0 };
  piles.targets.push(t);
  l.kickPiece(t);
}

// ---------- grass (decoration) ----------
// A few sparse tufts of grass, some with tiny square flowers on the tips. Flat and minimal: thin
// curved blades and square dots, always facing the camera, kept at least a couple of pixels
// wide whatever the zoom. They sway faintly in the breeze and bend aside as a llama brushes
// through. One mesh whose points are rewritten in place each frame (a few hundred triangles).
// To remove: set GRASS = false (or delete this section and its "grass:" hook in step).
const GRASS = FIXED_SPEED === null;
const GRASS_TUFTS = 8;
const GRASS_COL = new THREE.Color(0xb5bb98), FLOWER_COL = new THREE.Color(0xe9505e);
const BLADE_SEG = 5, BRUSH_R = 3.2;  // segments per blade; how close a llama has to pass to bend it
let grass = null;
if (GRASS) {
  const tufts = [], p = new THREE.Vector3();
  for (let tries = 0; tufts.length < GRASS_TUFTS && tries < 400; tries++) {
    randomGroundPoint(p, { x: 0, z: 0 }, 0);
    if (onRamp(p.x, p.z, 3)) continue;                                            // ramp: not on it
    if (piles && piles.pieces.some((q) => Math.hypot(q.body.position.x - p.x, q.body.position.z - p.z) < 5)) continue; // piles: clear of them
    if (paint && paint.blobs.some(([bx, bz, r]) => Math.hypot(p.x - bx, p.z - bz) < r + 3)) continue; // paint: nor in it
    if (tufts.some((t) => Math.hypot(t.x - p.x, t.z - p.z) < 12)) continue;      // sparse
    const n = 3 + Math.floor(Math.random() * 3), flowers = Math.random() < 0.6 ? Math.random() * 0.7 : 0;
    const blades = [];
    for (let i = 0; i < n; i++) blades.push({
      x: (Math.random() - 0.5) * 0.35,                                  // where it sprouts
      lean: (i / (n - 1) - 0.5) * 1.3 + (Math.random() - 0.5) * 0.35,   // fanned out, a bit untidy
      h: 0.9 + Math.random() * 0.8,
      flower: Math.random() < flowers,
    });
    tufts.push({ x: p.x, z: p.z, s: 0.8 + Math.random() * 0.5, blades, sw: 0, sv: 0 }); // sw/sv: bend, and its speed
  }
  // fixed-size buffers: 2 triangles per blade segment, plus 2 per flower; colours never change
  const tris = tufts.reduce((n, t) => n + t.blades.reduce((m, b) => m + BLADE_SEG * 2 + (b.flower ? 2 : 0), 0), 0);
  const geo = new THREE.BufferGeometry(), col = new Float32Array(tris * 9);
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tris * 9), 3).setUsage(THREE.DynamicDrawUsage));
  let i = 0;
  const paintTri = (k) => { for (let v = 0; v < 3; v++, i += 3) { col[i] = k.r; col[i + 1] = k.g; col[i + 2] = k.b; } };
  for (const t of tufts) for (const b of t.blades) {
    for (let k = 0; k < BLADE_SEG * 2; k++) paintTri(GRASS_COL);
    if (b.flower) { paintTri(FLOWER_COL); paintTri(FLOWER_COL); }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  mesh.frustumCulled = false;
  scene.add(mesh);
  grass = { tufts, mesh, t: 0 };
}
const _gR = new THREE.Vector3(), _gU = new THREE.Vector3();
// a blade's shape in its tuft's plane (u across the screen, v up), at q along it (0 base, 1 tip)
const bladeU = (t, b, q) => (b.x + (b.lean * 0.7 + t.bend) * b.h * q * q) * t.s;
// where a blade's tip is in the world right now (butterflies land on the flowers)
function bladeTip(t, b, out) {
  const u = bladeU(t, b, 1);
  return out.set(t.x + _gR.x * u, b.h * t.s, t.z + _gR.z * u);
}
function updateGrass(dt) {
  if (!grass) return;
  grass.t += dt;
  _gR.set(camDir.z, 0, -camDir.x).normalize();           // screen-right, along the ground
  _gU.setFromMatrixColumn(camera.matrixWorld, 1);        // screen-up
  // brushed: a llama passing close pushes the blades the way it's going (across the screen);
  // a spring brings them back, with a little wobble
  for (const t of grass.tufts) {
    let f = 0;
    for (const l of llamas) {
      const q = l.group.position, d = Math.hypot(q.x - t.x, q.z - t.z);
      if (d < BRUSH_R && dt > 0 && l.grassX !== undefined)
        f += ((q.x - l.grassX) * _gR.x + (q.z - l.grassZ) * _gR.z) / dt * (1 - d / BRUSH_R) * 3;
    }
    t.sv += (f - 30 * t.sw - 5 * t.sv) * dt;
    t.sw = clamp(t.sw + t.sv * dt, -0.8, 0.8);
    t.bend = t.sw + 0.05 * Math.sin(grass.t * 1.3 + t.x * 0.3);  // plus a faint breeze
  }
  for (const l of llamas) { l.grassX = l.group.position.x; l.grassZ = l.group.position.z; }

  const px = VIEW / Math.max(1, innerHeight);            // world units per screen pixel
  const w = Math.max(0.07, 1.6 * px), f = Math.max(0.13, 2.5 * px);
  const pos = grass.mesh.geometry.attributes.position, a = pos.array;
  let i = 0;
  const put = (x, y, z) => { a[i++] = x; a[i++] = y; a[i++] = z; };
  for (const t of grass.tufts) {
    const at = (u, v) => put(t.x + _gR.x * u, v + (t.y ?? 0), t.z + _gR.z * u);  // tuft plane → world (void: t.y, falling in)
    for (const b of t.blades) {
      for (let k = 0; k < BLADE_SEG; k++) {                // a ribbon, tapering toward the tip
        const q0 = k / BLADE_SEG, q1 = (k + 1) / BLADE_SEG;
        const u0 = bladeU(t, b, q0), v0 = b.h * t.s * q0, u1 = bladeU(t, b, q1), v1 = b.h * t.s * q1;
        const L = Math.hypot(u1 - u0, v1 - v0), nu = -(v1 - v0) / L, nv = (u1 - u0) / L;
        const ra = w * (1 - 0.5 * q0) / 2, rb = w * (1 - 0.5 * q1) / 2;
        at(u0 + nu * ra, v0 + nv * ra); at(u1 + nu * rb, v1 + nv * rb); at(u1 - nu * rb, v1 - nv * rb);
        at(u0 + nu * ra, v0 + nv * ra); at(u1 - nu * rb, v1 - nv * rb); at(u0 - nu * ra, v0 - nv * ra);
      }
      if (b.flower) {                                      // a square dot, square to the screen
        const u = bladeU(t, b, 1), cx = t.x + _gR.x * u, cy = b.h * t.s + (t.y ?? 0), cz = t.z + _gR.z * u;
        const ff = t.gone ? f * Math.min(1, t.s / 0.8) : f;  // (void: shrinks as its tuft sinks)
        const sq = (m, n) => put(cx + (_gR.x * m + _gU.x * n) * ff, cy + _gU.y * n * ff, cz + (_gR.z * m + _gU.z * n) * ff);
        sq(-1, -1); sq(1, -1); sq(1, 1); sq(-1, -1); sq(1, 1); sq(-1, 1);
      }
    }
  }
  pos.needsUpdate = true;
}

// ---------- rain (weather) ----------
// Every few minutes a short shower drifts through: the light dims a touch, thin 1px streaks fall
// at a slant with the wind, faint rings open where some land, and there's a soft hush of rain.
// The llamas carry on, squinting a little with their ears down; when it stops, each shakes off.
// Butterflies settle on a flower to wait it out. "Rain" in the panel turns showers on or off
// (switching it on brings one along in a few seconds).
// To remove: set RAIN = false (or delete this section, the #rain-tint markup/CSS and the small
// hooks marked "rain:").
const RAIN = FIXED_SPEED === null;
const RAIN_EVERY = [60, 120];    // seconds between showers (on screen: the clock pauses when the page is hidden)
const RAIN_LEN = [20, 32];       // how long one lasts (easing in and out)
const RAIN_DROPS = 280;          // streaks at the heaviest
const THUNDER_VOL = 0.5;         // ramp: thunder after a summit's lightning
const RAIN_TINT = 0.16;          // how much the light dims at the heaviest (0 = not at all)
const RIPPLE_CAP = 140, RIPPLE_LIFE = 0.75;
const DROPLET_COL = new THREE.Color(0x9fb3c8);
const BLIGHT_RAIN = 0.75;        // blight: past this much of the herd gone, it rains for good
let rainOn = RAIN, rainWait = 40 + Math.random() * 40, rainT = -1, rainLen = 0, rainK = 0; // rainK: 0 dry … 1 heaviest
let rain = null;
const rainTint = document.getElementById('rain-tint');
if (saved('llama-rain') === 'off') rainOn = false;
if (RAIN) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RAIN_DROPS * 6), 3).setUsage(THREE.DynamicDrawUsage));
  geo.setDrawRange(0, 0);
  const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x9aa9bb, transparent: true, opacity: 0 }));
  lines.frustumCulled = false;
  scene.add(lines);
  const ripples = new THREE.InstancedMesh(new THREE.RingGeometry(0.86, 1, 28).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ depthWrite: false }), RIPPLE_CAP);
  ripples.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(RIPPLE_CAP * 3), 3);
  ripples.frustumCulled = false;
  ripples.count = 0;
  ripples.renderOrder = -1;
  scene.add(ripples);
  rain = { lines, ripples, drops: [], rings: [], tick: 0, sound: null };
  for (let i = 0; i < RAIN_DROPS; i++) rain.drops.push({ x: 0, y: -1, z: 0, v: 0 });
}
const RAIN_FALL = new THREE.Vector3(Math.cos(WIND) * 4, -34, -Math.sin(WIND) * 4); // a gentle slant with the wind
const RAIN_STREAK = 1.3;
// a new drop somewhere above the visible ground (a box around the view, stretched along the camera's
// line of sight, since the tilted view sees further that way)
function dropSpawn(d, high) {
  const across = (Math.random() - 0.5) * VIEW * (innerWidth / Math.max(1, innerHeight)) * 1.2;
  const along = (Math.random() - 0.5) * VIEW * 2.2;
  const fx = camDir.x, fz = camDir.z, fl = Math.hypot(fx, fz) || 1;
  d.x = (fx / fl) * along + (fz / fl) * across;
  d.z = (fz / fl) * along - (fx / fl) * across;
  d.y = high ? 18 + Math.random() * 22 : 30 + Math.random() * 10;
  d.v = 0.9 + Math.random() * 0.25;
}
const _rm = new THREE.Matrix4(), _rc = new THREE.Color(), _rbg = new THREE.Color(), _rink = new THREE.Color(0x7d8ea4);
function startRain() {
  rainT = 0; rainLen = (RAIN_LEN[0] + Math.random() * (RAIN_LEN[1] - RAIN_LEN[0])) * (1 + 2 * blight); // blight: longer showers
  for (const d of rain.drops) dropSpawn(d, true);
}
function endRain() {
  rainT = -1; rainK = 0;
  rainWait = (RAIN_EVERY[0] + Math.random() * (RAIN_EVERY[1] - RAIN_EVERY[0])) * (1 - 0.85 * blight); // blight: more often
  for (const l of llamas) l.shakeOff(0.3 + Math.random() * 2.2);  // each in its own time
}
function updateRain(dt) {
  if (!rain) return;
  if (rainT < 0) { if (rainOn && !voidDrying() && ((rainWait -= dt) <= 0 || blight > BLIGHT_RAIN)) startRain(); } // (blight: near the end, straight away)
  else {
    rainT += dt;
    if (blight > BLIGHT_RAIN && rainOn && rainLen < INTRO_SHOWER && !voidDrying()) rainLen = Math.max(rainLen, rainT + 7); // blight: near the end, it doesn't stop
    if (voidDrying() && rainLen > rainT + 6.01) rainLen = rainT + 6;          // void: ...until the very end, when it eases off
    rainK = smooth(0, 5, rainT) * (1 - smooth(rainLen - 6, rainLen, rainT));
    if (rainT > rainLen || (!rainOn && !introOn && rainK < 0.02)) endRain();   // (intro: its shower falls regardless)
    if (!rainOn && !introOn) rainLen = Math.min(rainLen, rainT + 3);  // switched off mid-shower: wind it down
  }
  rainTint.style.opacity = rainK * RAIN_TINT;
  // the streaks
  const n = Math.round(RAIN_DROPS * rainK), a = rain.lines.geometry.attributes.position.array;
  const fl = RAIN_FALL.length(), sx = RAIN_FALL.x / fl * RAIN_STREAK, sy = RAIN_FALL.y / fl * RAIN_STREAK, sz = RAIN_FALL.z / fl * RAIN_STREAK;
  for (let i = 0; i < n; i++) {
    const d = rain.drops[i];
    if (d.y < 0) dropSpawn(d, false);
    d.x += RAIN_FALL.x * d.v * dt; d.y += RAIN_FALL.y * d.v * dt; d.z += RAIN_FALL.z * d.v * dt;
    const floor = groundHeight(d.x, d.z);
    if (d.y <= floor) {                                   // landed: now and then a ring opens there
      if (Math.random() < 0.3 && (floor === 0 || floor === RAMP_H)) rain.rings.push({ x: d.x, y: floor + 0.02, z: d.z, t: 0, s: 0.5 + Math.random() * 0.5 });
      dropSpawn(d, false);
    }
    a.set([d.x, d.y, d.z, d.x - sx, d.y - sy, d.z - sz], i * 6);
  }
  rain.lines.geometry.setDrawRange(0, n * 2);
  rain.lines.geometry.attributes.position.needsUpdate = true;
  rain.lines.material.opacity = 0.55 * Math.min(1, rainK * 2);
  // the rings: grow, and melt into the ground colour
  while (rain.rings.length > RIPPLE_CAP) rain.rings.shift();
  for (let i = rain.rings.length - 1; i >= 0; i--) if ((rain.rings[i].t += dt) > RIPPLE_LIFE) rain.rings.splice(i, 1);
  renderer.getClearColor(_rbg);
  rain.rings.forEach((r, i) => {
    const u = r.t / RIPPLE_LIFE, s = r.s * (0.2 + 0.8 * Math.sqrt(u));
    rain.ripples.setMatrixAt(i, _rm.makeScale(s, 1, s).setPosition(r.x, r.y, r.z));
    rain.ripples.setColorAt(i, _rc.copy(_rbg).lerp(_rink, 0.35 * (1 - u)));
  });
  rain.ripples.count = rain.rings.length;
  rain.ripples.instanceMatrix.needsUpdate = true;
  if (rain.ripples.instanceColor) rain.ripples.instanceColor.needsUpdate = true;
  rainSound(dt);
}
// the "Rain" checkbox in the panel
const rainIn = document.getElementById('rain');
if (!RAIN) document.getElementById('rain-row').remove();
else {
  rainIn.checked = rainOn;
  rainIn.addEventListener('change', () => {
    rainOn = rainIn.checked;
    try { localStorage.setItem('llama-rain', rainOn ? 'on' : 'off'); } catch {}
    if (rainOn && rainT < 0) rainWait = 3;                      // switched on: one along shortly
  });
}
// ramp: reaching the top (glitch mode) brings a shower along — or, if one's already falling, a
// flash of lightning (just the light: a quick double flicker, no bolt) and a roll of thunder
const flashEl = document.getElementById('flash');
function summitStorm() {
  if (!rain || !rainOn) return;
  if (rainT < 0) { startRain(); return; }
  flashEl.animate([{ opacity: 0 }, { opacity: 0.6, offset: 0.03 }, { opacity: 0.1, offset: 0.12 }, { opacity: 0.45, offset: 0.2 }, { opacity: 0 }],
    { duration: 900, easing: 'ease-out' });
  thunder(0.5 + Math.random() * 0.4);
}
// sfx: thunder, a little after the flash — a soft crack, then a low rumble that rolls and fades
function thunder(delay) {
  if (!actx || actx.state !== 'running' || !sfxOn) return;
  const t = actx.currentTime + delay, out = actx.createGain();
  out.gain.value = THUNDER_VOL;
  out.connect(sfxOut);
  for (const [freq, gain, attack, decay] of [[700, 0.25, 0.01, 0.5], [160, 1.6, 0.15, 3.5]]) { // crack, rumble
    const src = actx.createBufferSource(), f = actx.createBiquadFilter(), g = actx.createGain();
    src.buffer = sfxNoise; src.loop = true;
    f.type = 'lowpass'; f.frequency.setValueAtTime(freq, t); f.frequency.exponentialRampToValueAtTime(freq * 0.5, t + attack + decay);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    src.connect(f).connect(g).connect(out);
    src.start(t, Math.random() * 0.5); src.stop(t + attack + decay + 0.1);
  }
  const roll = actx.createOscillator(), depth = actx.createGain();   // the roll: a slow wobble in level
  roll.frequency.value = 2.3; depth.gain.value = 0.35;
  roll.connect(depth).connect(out.gain);
  roll.start(t); roll.stop(t + 4);
}
// intro: a shower already falling behind the title, which clears soon after your llama drops in
if (rain && INTRO && INTRO_RAIN) {
  startRain();
  rainT = 5; rainK = 1; rainLen = INTRO_SHOWER;              // at full strength (until the snap sets its end)
  for (const d of rain.drops) d.y = Math.random() * 40;  // already falling all the way down
}
// sfx: a soft hush (filtered noise, swelling with the shower) and the odd quiet drip
function rainSound(dt) {
  if (!actx || actx.state !== 'running' || !sfxNoise) return;
  if (rainK > 0 && !rain.sound && sfxOn) {
    const src = actx.createBufferSource(), hp = actx.createBiquadFilter(), lp = actx.createBiquadFilter(), g = actx.createGain();
    src.buffer = sfxNoise; src.loop = true;
    hp.type = 'highpass'; hp.frequency.value = 500;
    lp.type = 'lowpass'; lp.frequency.value = 3200;
    g.gain.value = 0;
    src.connect(hp).connect(lp).connect(g).connect(sfxOut);
    src.start();
    rain.sound = { src, g };
  }
  if (!rain.sound) return;
  rain.sound.g.gain.setTargetAtTime(sfxOn ? rainK * 0.03 : 0, actx.currentTime, 0.4);
  if (rainK === 0 && rainT < 0) {                        // shower over: let it fade, then stop
    const s = rain.sound; rain.sound = null;
    s.g.gain.setTargetAtTime(0, actx.currentTime, 0.4);
    s.src.stop(actx.currentTime + 2.5);
  }
  if (sfxOn && Math.random() < rainK * dt * 3) {          // a drip, somewhere
    const t = actx.currentTime, f = 1800 + Math.random() * 1600;
    sfxTone(t, (Math.random() - 0.5) * 1.2, { from: f, to: f * 0.7, gain: 0.006 * rainK, decay: 0.03 });
  }
}

// ---------- butterflies (decoration) ----------
// A couple of butterflies drift about, flapping, and every so often settle: on a grass flower,
// or on the head of a llama that's standing still (they take off again if it moves).
// To remove: set BUTTERFLIES = false (or delete this section and its hook in step).
const BUTTERFLIES = FIXED_SPEED === null;
const BFLY_COLS = [0xf1d68e, 0xa3bccd];   // butter, dusty blue
const BFLY_SPEED = 3.2;
const flies = [];
if (BUTTERFLIES) {
  // one wing: a forewing and a smaller hindwing, flat, reaching out to the side (+z) from the body
  const wing = mergeGeometries([
    new THREE.CircleGeometry(0.36, 14).scale(0.8, 1, 1).rotateX(-Math.PI / 2).translate(0.1, 0, 0.32),
    new THREE.CircleGeometry(0.24, 12).scale(0.8, 1, 1).rotateX(-Math.PI / 2).translate(-0.17, 0, 0.22),
  ]);
  const wingL = wing, wingR = wing.clone().scale(1, 1, -1);
  const bodyGeo = new THREE.CapsuleGeometry(0.045, 0.36, 3, 6).rotateZ(Math.PI / 2);
  const bodyMat = new THREE.MeshBasicMaterial({ color: 0x555555 });
  for (const c of BFLY_COLS) {
    const g = new THREE.Group(), m = new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide });
    const l = new THREE.Mesh(wingL, m), r = new THREE.Mesh(wingR, m);
    g.add(l, r, new THREE.Mesh(bodyGeo, bodyMat));
    const start = randomGroundPoint(new THREE.Vector3(), { x: 0, z: 0 }, 0);
    g.position.set(start.x, 3 + Math.random() * 2, start.z);
    scene.add(g);
    flies.push({ g, l, r, v: new THREE.Vector3(), t: Math.random() * 10, state: 'fly', target: new THREE.Vector3(), spot: null, rest: 0, wait: 0 });
  }
  if (INTRO && !INTRO_CUTE) introFly();
  flies.forEach(pickFlight);
}
// intro: the butter-yellow one flutters over the title card too. It's drawn a second time, alone,
// on a see-through canvas above the card (same camera, same frame), until the snap. (void: again
// when the title card comes back — it's the last thing left alive)
function introFly() {
  const fl = flies[0], over = new THREE.WebGLRenderer({ antialias: false, alpha: true });
  over.setPixelRatio(renderer.getPixelRatio());
  over.setClearColor(0x000000, 0);
  over.domElement.id = 'intro-fly';
  document.body.append(over.domElement);
  fl.g.traverse((o) => o.layers.enable(1));           // layer 1: what the extra canvas draws
  fl.intro = true;
  introLayer = {
    draw() {
      const c = renderer.domElement;
      if (over.domElement.width !== c.width || over.domElement.height !== c.height) over.setSize(innerWidth, innerHeight);
      camera.layers.set(1); over.render(scene, camera); camera.layers.set(0);
    },
    end() {
      over.domElement.remove(); over.dispose();
      fl.g.traverse((o) => o.layers.disable(1));
      fl.intro = false;
    },
  };
}
const _fb = new THREE.Vector3(), _fd = new THREE.Vector3();
// somewhere to go: usually a flower to settle on, sometimes a resting llama, sometimes just a wander
function pickFlight(fl) {
  const flowers = grass ? grass.tufts.filter((t) => !t.gone).flatMap((t) => t.blades.filter((b) => b.flower).map((b) => ({ t, b }))) : []; // (void: not ones going under)
  const resting = llamas.filter((l) => l.group.position.distanceToSquared(l.lastPos ?? l.group.position) < 1e-6 && !l.petting && !l.gone);
  const r = (fl.intro && introOn) || voidOpen ? 1          // intro: keeps fluttering about over the title (void: nowhere to land)
    : rainK > 0.15 ? 0 : Math.random();                  // rain: head for a flower to wait it out
  fl.spot = null;
  if (r < 0.45 && flowers.length) fl.spot = { flower: pick(flowers) };
  else if (r < 0.7 && resting.length) fl.spot = { llama: pick(resting) };
  if (!fl.spot) { randomGroundPoint(fl.target, fl.g.position, 6); fl.target.y = 2.5 + Math.random() * 3; }
  fl.state = 'fly';
}
// where a settling spot is right now (flowers sway, llamas move their heads)
function spotPos(spot, out) {
  if (spot.flower) return bladeTip(spot.flower.t, spot.flower.b, out).setY(out.y + 0.12);
  spot.llama.head.getWorldPosition(out);
  return out.setY(out.y + 0.95);                         // on top of the head, between the ears
}
function updateButterflies(dt) {
  for (const fl of flies) {
    fl.t += dt;
    const g = fl.g;
    if (fl.state === 'gone') continue;
    // void: any but the yellow one, crossing over the pit, is pulled down into it, wings slowing
    if (vd.on && fl !== flies[0] && fl.state !== 'fall' && Math.hypot(g.position.x - vd.x, g.position.z - vd.z) < vd.r * 0.9) { fl.state = 'fall'; fl.v.set(0, 0, 0); }
    if (fl.state === 'fall') {
      fl.v.y -= 9 * dt; g.position.addScaledVector(fl.v, dt);
      const a = 0.15 + 1.0 * (0.5 + 0.5 * Math.sin(fl.t * 5)); fl.l.rotation.x = -a; fl.r.rotation.x = a;
      if (g.position.y < -60) { fl.state = 'gone'; g.visible = false; }
      continue;
    }
    if (fl.state === 'rest') {
      spotPos(fl.spot, g.position);
      const l = fl.spot.llama, moved = l && (l.group.position.distanceToSquared(l.lastPos) > 1e-4 || l.petting);
      if (((fl.rest -= dt) < 0 && rainK < 0.15) || moved || fl.spot.flower?.t.gone || l?.gone) { pickFlight(fl); fl.v.set(0, 2, 0); } // (rain: stays put; void: its perch is going under)
      // resting: wings mostly closed overhead, slowly fanning
      const a = 1.25 - 0.25 * (0.5 + 0.5 * Math.sin(fl.t * 2.5));
      fl.l.rotation.x = -a; fl.r.rotation.x = a;
      continue;
    }
    const goal = fl.spot ? spotPos(fl.spot, _fb) : fl.target;
    _fd.subVectors(goal, g.position);
    const d = _fd.length();
    if (d < 0.35 && fl.spot) { fl.state = 'rest'; fl.rest = 3 + Math.random() * 5; continue; }
    if (d < 1 && !fl.spot) { pickFlight(fl); continue; }
    // steer toward it, fluttering: a sideways weave and a bob
    _fd.multiplyScalar(1 / Math.max(d, 1e-3));
    const speed = BFLY_SPEED * Math.min(1, 0.4 + d / 3);
    fl.v.lerp(_fd.multiplyScalar(speed), 1 - Math.exp(-2.5 * dt));
    g.position.addScaledVector(fl.v, dt);
    g.position.x += Math.sin(fl.t * 3.1) * 0.6 * dt * fl.v.z / (speed + 0.01);
    g.position.z -= Math.sin(fl.t * 3.1) * 0.6 * dt * fl.v.x / (speed + 0.01);
    g.position.y += Math.sin(fl.t * 7) * 0.9 * dt;
    if (fl.v.x * fl.v.x + fl.v.z * fl.v.z > 0.04) g.rotation.y = Math.atan2(-fl.v.z, fl.v.x);
    const a = 0.15 + 1.0 * (0.5 + 0.5 * Math.sin(fl.t * 19));   // flapping
    fl.l.rotation.x = -a; fl.r.rotation.x = a;
  }
  for (const l of llamas) (l.lastPos ??= new THREE.Vector3()).copy(l.group.position);
}

// ---------- dust puffs (detail) ----------
// A little burst of soft dots at a llama's feet when it lands from a hop or pronk, or pulls up
// short when a ball hits it. They spread a touch, drift up and shrink away in about half a second.
// To remove: set DUST = false (or delete this section and the small hooks marked "dust:").
const DUST = FIXED_SPEED === null;
const DUST_CAP = 96, DUST_LIFE = 0.55;
const dust = [];
let dustMesh = null;
if (DUST) {
  dustMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 6), new THREE.MeshBasicMaterial({ depthWrite: false }), DUST_CAP);
  dustMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(DUST_CAP * 3), 3);
  dustMesh.frustumCulled = false;
  dustMesh.count = 0;
  scene.add(dustMesh);
}
// n dots, spreading from (x, y, z). Dust by default; `col`/`r`/`v`/`vy`/`g` make other kinds
// (rain: water droplets flung off in a shake)
function puff(x, y, z, n = 6, { col = null, r = 0.22, v = 1.6, vy = 0.6, g = 0, spread = 0.8 } = {}) {
  if (!dustMesh) return;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + Math.random() * 0.6, sp = v * (1 + Math.random() * 0.75);
    dust.push({ x: x + Math.cos(a) * spread, y: y + 0.15, z: z - Math.sin(a) * spread, vx: Math.cos(a) * sp, vz: -Math.sin(a) * sp,
      vy: vy * (1 + Math.random()), g, r: r * (1 + Math.random() * 0.7), col, t: 0 });
  }
  while (dust.length > DUST_CAP) dust.shift();
}
const _dm = new THREE.Matrix4(), _dc = new THREE.Color(), _dk = new THREE.Color(0x000000), _dg = new THREE.Color();
function updateDust(dt) {
  if (!dustMesh) return;
  for (let i = dust.length - 1; i >= 0; i--) if ((dust[i].t += dt) > DUST_LIFE) dust.splice(i, 1);
  // dust: a soft grey that suits whatever colour the ground is
  _dg.copy(renderer.getClearColor(_dc)).lerp(_dk, 0.12);
  dust.forEach((d, i) => {
    const drag = Math.exp(-5 * dt);
    d.vx *= drag; d.vz *= drag; d.vy -= d.g * dt;
    d.x += d.vx * dt; d.z += d.vz * dt; d.y = Math.max(0.1, d.y + d.vy * dt);
    const s = d.r * (1 - smooth(0.15, 1, d.t / DUST_LIFE));
    _dm.makeScale(s, s, s).setPosition(d.x, d.y, d.z);
    dustMesh.setMatrixAt(i, _dm);
    dustMesh.setColorAt(i, d.col ?? _dg);
  });
  dustMesh.count = dust.length;
  dustMesh.instanceMatrix.needsUpdate = true;
  dustMesh.instanceColor.needsUpdate = true;
}

// ---------- gather the herd (optional mini-goal) ----------
// Press and hold a wanderer to herd it: a bar fills in a bubble above it, then it hops, pops a
// heart and trots over to follow your llama in a conga line (hold one that's already in line
// to let it go). A speech bubble over your llama counts the herd. Once everyone's in line the
// herd dances, disbands, and it can be played again. Take longer than herdTime() from the first
// one and the line breaks up (the counter pulses for the last few seconds).
// To remove: set GATHER = false — or delete this section, the #herd-bubble / #hold-tip markup
// and CSS, and the small hooks marked "gather:" in the llama code.
const GATHER = FIXED_SPEED === null;
const HOLD_DELAY = 0.15;   // seconds before the bar starts (so taps stay taps)
const HOLD_TIME = 0.75;    // seconds of holding to fill the bar
// herd everyone within this many seconds of the first, or the line breaks up (45s for the five
// you start with; more llamas, more time)
const herdTime = () => 15 + 6 * (llamas.length - 1);
const HERD_RANGE = 20;     // your llama has to be this close to one to herd it (or let it go)
const LINE_GAP = 7;        // spacing between llamas in the line
const PARTY_LEN = 3.2;     // finale length, then everyone wanders off
const YIELD_WIDTH = 6;     // followers this close to your llama's path step out of its way
const REGATHER_AFTER = 2;  // pause before the game can be played again
const line = [];           // followers in order, nearest to you first
let party = -1, cooldown = 0, hintPause = 0, herdT = 0;
const bubbleEl = document.getElementById('herd-bubble');
const tipEl = document.getElementById('hold-tip');
const tipText = tipEl.querySelector('span'), tipBar = tipEl.querySelector('.bar i');
const _slot = new THREE.Vector3(), _ui = new THREE.Vector3();
const hexOf = (l) => '#' + l.coat.toString(16).padStart(6, '0');
const atLlama = (l) => ({ getWorldPosition: (v) => v.copy(l.group.position).setY(9.5) }); // heart() anchor
// screen position of a point above a llama's head
function aboveHead(l, lift) {
  l.head.getWorldPosition(_ui);
  _ui.y += lift;
  _ui.project(camera);
  return [(_ui.x * 0.5 + 0.5) * innerWidth, (-_ui.y * 0.5 + 0.5) * innerHeight];
}

function renderBubble(done = false) {
  if (!GATHER) return;
  const others = llamas.filter((l) => l !== player);
  bubbleEl.innerHTML = others.map((l) => line.includes(l) ? `<i class="on" style="background:${hexOf(l)}"></i>` : '<i></i>').join('')
    + (done ? '<b>♥</b>' : '');
  bubbleEl.classList.toggle('done', done);
  bubbleEl.classList.toggle('show', line.length > 0 || done);
}
function releaseLine() {
  for (const l of line) { l.followTarget = null; l.followLeader = null; }
  line.length = 0;
}
function herd(l) {
  line.push(l);
  l.poke(true);                                     // a happy hop (or waking from a nap)
  sfx.herdJoin(l.group.position, line.length);      // sfx:
  if (!l.ill()) heart(atLlama(l));                // (blight: not from the sick)
  renderBubble();
}
function gatherStep(dt) {
  if (!GATHER) return;
  for (let i = line.length - 1; i >= 0; i--) if (!llamas.includes(line[i])) line.splice(i, 1); // removed via panel
  const others = llamas.filter((l) => l !== player);
  if (bubbleEl.childElementCount - (party >= 0 ? 1 : 0) !== others.length) renderBubble(party >= 0);

  // the speech bubble rides above your llama's head
  if (line.length || party >= 0) {
    const [bx, by] = aboveHead(player, 2.6);
    bubbleEl.style.translate = `calc(${bx}px - 50%) calc(${by}px - 100%)`;
  }

  // Hovering a wanderer (near enough) shows a bubble above it, "hold to herd" over an empty bar;
  // pressing fills the bar in its colour; when full the llama is herded (or let go if in line).
  if (press) press.t += dt;                         // time every press (taps poke on release)
  hintPause = Math.max(0, hintPause - dt);
  const pressing = press && !press.claimed ? press.llama : null;
  const focus = pressing ?? (!press && hintPause <= 0 ? pointerOn : null); // let the pop play before hinting again
  const canHerd = focus && focus !== player && !line.includes(focus) && !focus.fallen /* blight: */ && party < 0 && cooldown <= 0 && llamas.includes(focus) &&
    focus.group.position.distanceTo(player.group.position) < HERD_RANGE;
  if (canHerd) {
    const holding = pressing === focus && press.t > HOLD_DELAY;
    const k = holding ? clamp((press.t - HOLD_DELAY) / HOLD_TIME, 0, 1) : 0;
    const [bx, by] = aboveHead(focus, 2.6);
    tipEl.style.translate = `calc(${bx}px - 50%) calc(${by}px - 100%)`;
    tipText.innerHTML = `<i>${focus.name}</i> · hold to <b>♥</b>`;
    tipBar.style.background = hexOf(focus);
    tipBar.style.width = k * 100 + '%';
    tipEl.classList.remove('done');                 // a finished pop would otherwise keep it hidden
    tipEl.classList.add('show');
    if (k >= 1) {
      press.claimed = true;
      tipEl.classList.remove('show');
      void tipEl.offsetWidth; tipEl.classList.add('done'); // pop
      hintPause = 0.9;
      herd(focus);
    }
  } else {
    tipEl.classList.remove('show');
  }

  if (party >= 0) {                                 // finale running
    party += dt;
    if (party > PARTY_LEN) { party = -1; cooldown = REGATHER_AFTER; releaseLine(); renderBubble(); }
    return;
  }
  if (cooldown > 0) { cooldown -= dt; return; }

  // the clock: starts with the first one herded; it pulses near the end, then the line breaks up
  herdT = line.length ? herdT + dt : 0;
  bubbleEl.classList.toggle('hurry', herdT > herdTime() - 6);
  if (herdT > herdTime()) {
    sfx.herdLost(player.group.position);
    releaseLine();
    renderBubble();
    bubbleEl.classList.remove('hurry');
    herdT = 0;
    return;
  }

  // each follower aims one gap behind the llama in front of it, but your llama has right of way:
  // a follower standing in the corridor between your llama and where it's heading steps aside
  const me = player.group.position;
  const px = hasTarget ? target.x - me.x : 0, pz = hasTarget ? target.z - me.z : 0, plen = Math.hypot(px, pz);
  line.forEach((l, i) => {
    const lead = i === 0 ? player : line[i - 1];
    const h = lead.group.rotation.y;
    l.followLeader = lead;
    l.followTarget = l.followTarget ?? new THREE.Vector3();
    const p = l.group.position, rx = p.x - me.x, rz = p.z - me.z;
    const along = plen > 1 ? (rx * px + rz * pz) / plen : -1;        // how far along your path
    const across = plen > 1 ? (rx * pz - rz * px) / plen : 0;        // signed distance off it
    if (plen > 1 && along > -2 && along < plen + 2 && Math.abs(across) < YIELD_WIDTH) {
      const away = across >= 0 ? 1 : -1;                             // step out on the side it's on
      l.followTarget.set(p.x + (pz / plen) * away * 8, 0, p.z - (px / plen) * away * 8);
    } else {
      l.followTarget.copy(lead.group.position).add(_slot.set(-Math.cos(h) * LINE_GAP, 0, Math.sin(h) * LINE_GAP));
    }
  });
  // everyone's here: party
  const living = others.filter((l) => !l.fallen).length;      // blight: the fallen can't come
  if (living > 0 && line.length === living) {
    party = 0;
    renderBubble(true);
    for (const l of llamas) if (!l.fallen && !l.ill()) { l.celebrate(); heart(atLlama(l)); } // (blight: not the dead or sick)
    sfx.party(player.group.position);               // sfx:
  }
}
if (GATHER) {
  renderBubble();
  // a one-off nudge once they've been playing a little while
  addEventListener('pointermove', () => setTimeout(() => {
    if (line.length || party >= 0) return;
    hint.textContent = TOUCH ? 'hold a llama to herd it, rub it to pet it' : 'press and hold a llama to herd it'; hint.style.opacity = 1;
    setTimeout(() => { hint.style.opacity = 0; }, 4500);
  }, 30000), { once: true });
}

function step(dt) {
  if (FIXED_SPEED === null) pointerIdle = introOn ? 0 : pointerIdle + dt; // intro: no napping before it appears
  updateBalls(dt);
  updateRamp(dt);
  updatePaint(dt);
  updateGrass(dt);                  // grass:
  updateButterflies(dt);            // butterflies:
  updateDust(dt);                   // dust:
  updateRain(dt);                   // rain:
  updatePokeTip(dt);                // sfx:
  updateMusic(dt);                  // music:
  gatherStep(dt);
  if (introOn && !introGo && INTRO_SPIN && INTRO_CUTE) setOrbit(camOrbit + INTRO_SPIN * dt); // intro: the slow turn while it waits...
  if (homing) {                                                                  // ...and the glide home after Play
    homing.t = Math.min(1, homing.t + dt / homing.len);
    setOrbit(homing.from + homing.by * smoother(homing.t));
    if (homing.t >= 1) homing = null;
  }
  blightStep(dt);                   // blight:
  voidStep(dt);                     // void:
  updateCarrion(dt);                // carrion:
  for (const l of llamas) l.update(dt);
  personalSpace(dt);
  updatePiles(dt);                  // piles:
}

// ---------- blight (the infection) ----------
// Your llama doesn't belong here, and just by being here it makes the others sick. Each wanderer
// slowly catches it on its own (so in the end it's inevitable), and much faster near yours:
// beside it, herded in its line, and fastest of all while you pet it. Sick, a llama's coat drains
// toward grey, it slows and gets unsteady, its head hangs and it stops greeting the others; then
// it sways, and keels over onto its side, X X. `blight` (0..1) is how far it's spread through the
// herd — later stages (music, rain, the void) read it. "Blight" in the panel switches it off (the
// herd recovers and gets back up). Only counts on-screen time, and not during the intro.
// Testing: ?blight=0.6 starts it that far along; ?blightspeed=20 runs it 20× faster.
// To turn off: BLIGHT_ON = false. To remove: delete this section, #blight-row in index.html, and
// the small hooks marked "blight:".
const BLIGHT = BLIGHT_ON && FIXED_SPEED === null;
// Pacing: each llama has its own time to fall, on the blight's clock (seconds of play). Left alone
// they're spread from the end of a calm first minute to BLIGHT_SLOW; time spent near yours pulls a
// llama's time earlier, but never so the herd goes faster than BLIGHT_FAST, and never two too close.
const BLIGHT_CALM = 45;        // ← seconds of play before anyone can fall
const BLIGHT_FAST = 3;         // ← however you play, the last of the herd falls between this many minutes...
const BLIGHT_SLOW = 4.25;      // ← ...and this many
const BLIGHT_GAP = 15;         // ← seconds at least between one falling and the next (so each gets its moment)
const BLIGHT_SICK = 60;        // seconds of visible decline before a llama falls
const INSPECT_LOOK = 4.5;      // seconds a curious one stands looking at a fallen one
const BLIGHT_NEAR = 8;         // within this of yours (centre to centre) a llama is catching it...
const BLIGHT_PULL = 1;         // ← ...and every second of that brings its time this many seconds closer (petted: 4×)
const BLIGHT_RECOVER = 15;     // switched off: seconds for a sick llama to get well again
const BLIGHT_SPEED = parseFloat(params.get('blightspeed') || '1');
const BLIGHT_GLITCH = 0.35;    // past this (and with a couple fallen), your llama glitches now and then
const BLIGHT_PRINTS = 0.5;     // past this, it leaves black footprints (until the void opens)
const BLIGHT_PRINT_LIFE = 7;   // seconds each black print lasts
const _blackPrint = new THREE.Color(0x111111);
const burst = { wait: 3, t: 0, k: 0, own: false }; // your llama's glitch bursts
let blightOn = BLIGHT;
if (saved('llama-blight') === 'off') blightOn = false;
const wanderers = () => llamas.filter((l) => l !== player);
// each llama's own pace: some succumb early, some hold out to the end
const pace = { t: 0, lastFall: -Infinity };   // the blight's own clock (seconds of play), and when the last one fell
// give any llama without one a time to fall: spread out (in a shuffled order) between now (or the
// end of the calm) and BLIGHT_SLOW
function blightDues(herd) {
  const fresh = herd.filter((l) => l.due === undefined).sort(() => Math.random() - 0.5);
  const from = Math.max(pace.t, BLIGHT_CALM) + BLIGHT_GAP, to = Math.max(from + BLIGHT_GAP, BLIGHT_SLOW * 60);
  fresh.forEach((l, j) => { l.due = from + (to - from) * ((j + 1) / fresh.length) * lerp(0.85, 1, Math.random()); });
}
function blightStep(dt) {
  if (!BLIGHT || introOn) return;
  const me = player.group.position, k = dt * BLIGHT_SPEED;
  const herd = wanderers(), n = herd.length;
  blightDues(herd);
  if (blightOn) {
    pace.t += k;
    // near yours (beside it, herded, petted), a llama's time comes sooner...
    for (const l of herd) if (!l.fallen && (l.followLeader || l.group.position.distanceTo(me) < BLIGHT_NEAR)) l.due -= k * BLIGHT_PULL * (l.petting ? 4 : 1);
    // ...but the k-th to fall can't go before its place on the fast pace, nor within BLIGHT_GAP of the last
    const down = herd.filter((l) => l.fallen).length;
    const next = herd.filter((l) => !l.fallen).sort((a, b) => a.due - b.due)[0];
    const earliest = BLIGHT_CALM + (BLIGHT_FAST * 60 - BLIGHT_CALM) * (down + 1) / n;
    if (next) next.due = Math.max(next.due, earliest, pace.lastFall + BLIGHT_GAP);
    if (next && pace.t >= next.due) {
      pace.lastFall = pace.t;
      next.sick = 1;
      next.keel();
      const near = herd.filter((o) => o !== next && !o.fallen && o.group.position.distanceTo(next.group.position) < 28)  // one of the others nearby comes to look
        .sort((a, b) => a.group.position.distanceTo(next.group.position) - b.group.position.distanceTo(next.group.position))[0];
      if (near) setTimeout(() => near.inspect(next), (KEEL_SWAY + KEEL_TIP + 0.6) * 1000);   // (once it's down)
      const i = line.indexOf(next);                      // gather: a fallen one leaves the line
      if (i >= 0) { line.splice(i, 1); next.followTarget = null; next.followLeader = null; renderBubble(); }
    }
    // how sick each looks: it builds over the BLIGHT_SICK seconds before its time
    for (const l of herd) if (!l.fallen) l.sick = clamp(1 - (l.due - pace.t) / BLIGHT_SICK, 0, 0.995);
  } else for (const l of herd) {                         // switched off: they get well (their time moves away)
    if (l.fallen) { l.rise(); l.due = Math.max(l.due, pace.t + BLIGHT_SICK); }
    l.due += k * BLIGHT_SICK / BLIGHT_RECOVER;
    l.sick = clamp(1 - (l.due - pace.t) / BLIGHT_SICK, 0, 0.995);
  }
  blight = n ? herd.reduce((a, l) => a + (l.fallen ? 1 : l.sick), 0) / n : 0;
  // your llama glitches: short bursts, more often as it spreads (with the summit's broken hum, no boom)
  const down = herd.filter((l) => l.fallen).length;
  if (blightOn && blight > BLIGHT_GLITCH && down >= 2 && burst.t <= 0 && (burst.wait -= dt) <= 0) {
    burst.t = 0.25 + Math.random() * 0.7; burst.k = 0.5 + Math.random() * 0.5;
    burst.wait = lerp(14, 4, blight) * (0.6 + Math.random() * 0.8);
    if (!glitch.snd) { glitch.snd = glitchSound(player.group.position, false); burst.own = !!glitch.snd; }
  }
  if (burst.t > 0 && (burst.t -= dt) <= 0 && burst.own) { glitchSoundEnd(glitch.snd); glitch.snd = null; burst.own = false; }
  blightGlitch = burst.t > 0 ? burst.k : 0;
  if (blightPct) blightPct.textContent = Math.round(blight * 100) + '%';
}
// the panel: on/off and how far it's spread
const blightIn = document.getElementById('blight'), blightPct = document.getElementById('blight-pct');
if (!BLIGHT) document.getElementById('blight-row').remove();
else {
  blightIn.checked = blightOn;
  blightIn.addEventListener('change', () => {
    blightOn = blightIn.checked;
    try { localStorage.setItem('llama-blight', blightOn ? 'on' : 'off'); } catch {}
  });
  // testing: ?blight=0.6 — that much of the herd already sick or fallen (the earliest to go first)
  if (params.has('blight')) {
    const herd = wanderers(), b0 = clamp(parseFloat(params.get('blight')), 0, 1), gone = Math.floor(b0 * herd.length + 1e-6);
    pace.t = BLIGHT_CALM + b0 * (BLIGHT_FAST * 60 - BLIGHT_CALM);   // (its clock as if it had got this far)
    pace.lastFall = pace.t - BLIGHT_GAP;
    herd.forEach((l, i) => {
      if (i < gone) { l.due = pace.t - 1; l.sick = 1; l.keel(true); }
      else l.due = pace.t + BLIGHT_GAP * (i - gone + 1) * 1.5;   // the rest close behind
    });
  }
}

// ---------- flies over the fallen (detail) ----------
// A little while after a llama has died, a few tiny flies — single dark pixels — buzz about over
// it, in quick jittery loops. One points draw call for all of them.
// To remove: set CARRION = false (or delete this section and its hook in step).
const CARRION = BLIGHT;
const CARRION_N = 3;           // flies per fallen llama
const CARRION_AFTER = 3;       // seconds after it falls before they find it
let carrion = null;
if (CARRION) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_LLAMAS * CARRION_N * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geo.setDrawRange(0, 0);
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0x2a2a2a, size: 2 * renderer.getPixelRatio(), sizeAttenuation: false }));
  pts.frustumCulled = false;
  scene.add(pts);
  carrion = { pts, t: 0 };
}
function updateCarrion(dt) {
  if (!carrion) return;
  const t = (carrion.t += dt), a = carrion.pts.geometry.attributes.position.array;
  let n = 0;
  for (const l of llamas) {
    if (l === player || l.gone || !l.fallen) { l.deadT = 0; continue; }
    if ((l.deadT = (l.deadT ?? 0) + dt) < CARRION_AFTER) continue;
    const p = l.group.position, seed = l.id.length * 7.3 + (l.name?.length ?? 0);
    for (let k = 0; k < CARRION_N && (l.deadT - CARRION_AFTER) > k * 1.5; k++, n++) { // they arrive one by one
      const ph = seed + k * 2.1;
      a[n * 3] = p.x + Math.sin(t * 2.3 + ph) * 1.6 + Math.sin(t * 7.1 + ph * 3) * 0.35;
      a[n * 3 + 1] = 1.6 + Math.abs(Math.sin(t * 1.7 + ph)) * 1.4 + Math.sin(t * 9.3 + ph) * 0.2;
      a[n * 3 + 2] = p.z + Math.cos(t * 2.9 + ph * 1.3) * 1.6 + Math.cos(t * 6.4 + ph * 2) * 0.35;
    }
  }
  carrion.pts.geometry.setDrawRange(0, n);
  carrion.pts.geometry.attributes.position.needsUpdate = true;
}

// ---------- the void (the end) ----------
// Before the last of the herd has fallen, a pit opens under your llama (its legs go all black): a
// hole in the ground with walls dropping away in flat bands of charcoal, darker the deeper they go
// (never quite black, so your llama still stands out). It trails after your llama, growing all the
// time and faster as you walk, its edge slowly breathing. Whatever its edge reaches tips over the
// brink — slowly at first, then faster, as a weight would — and falls into the depths: the fallen
// llamas, the grass, the toys, the paint, the balls, the ramp (any llama still standing there
// collapses first). The blue butterfly is pulled down too; the yellow one is the last thing alive.
// As it fills the view the pit darkens to black, the rain eases off, everything goes quiet — and
// with a snap the title card is back (the yellow butterfly still fluttering over it) and the
// world behind it is new again, waiting for Play.
// How: an invisible copy of the ground (depth only) with the hole cut out hides whatever falls
// below it; the walls are drawn under it, seen only through the hole.
// Testing: VOID_NOW = true (or ?void=1) opens it straight away; ?blight=1 a few seconds in.
// To turn off: VOID_ON = false. To remove: delete this section, #void-ui in style.css, and the
// small hooks marked "void:".
const VOID_ON = true;          // ← false: the world just stays fallen
const VOID_NOW = false;        // ← temporary, for testing: true opens it as soon as the scene starts
const VOID = VOID_ON && BLIGHT;
const VOID_AT = 0.8;           // opens once the blight has spread this far (a few may still be standing)
const VOID_WAIT = 4;           // ...after this many seconds
const VOID_GROW = 0.45;        // world units a second it grows by itself (a little faster as it gets bigger)...
const VOID_WALK = 0.06;        // ...plus this much for every unit your llama walks (a little: it takes about a minute either way)
const VOID_FALL = 30;          // gravity, for things going over the edge
const VOID_RUSH = 6;           // how much faster it grows over the last stretch (once it covers ~70% of the view)
const VOID_DRY = 0.5;          // once it covers this much of the view, the rain eases off
const VOID_DARK = [0.55, 0.98];// ...and over this much, the pit darkens to black (and the sound fades)
const VOID_HOLD = 1.5;         // seconds of black before the snap
// the walls: bands from the rim down (depth where each ends, colour)
const VOID_BANDS = [[2, 0x48484e], [6, 0x36363b], [14, 0x29292d], [30, 0x1e1e21], [70, 0x151517], [400, 0x0c0c0d]];
const _vp = new THREE.Vector3(), _vn = new THREE.Vector2(), _vq = new THREE.Quaternion();
const vd = { on: false, wait: VOID_WAIT, r: 0, x: 0, z: 0, t: 0, falling: [], end: -1, lx: 0, lz: 0, cover: 0 };
const voidDrying = () => vd.on && vd.cover > VOID_DRY;   // rain: no more showers, and the last one eases off
if (VOID) {
  const N = 120, R = N + 1;
  vd.N = N;
  // the ground with the hole in it: a ring from the rim out to far away, depth only
  const ringGeo = new THREE.BufferGeometry(), ringIdx = [];
  ringGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(R * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
  for (let i = 0; i < N; i++) ringIdx.push(i, i + 1, R + i, i + 1, R + i + 1, R + i);
  ringGeo.setIndex(ringIdx);
  vd.ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide }));
  vd.ring.renderOrder = -10;                         // first, so everything below ground outside the hole is hidden
  // the walls: a band of rows per colour, straight down from the rim
  const rows = VOID_BANDS.length * 2, wallGeo = new THREE.BufferGeometry(), col = new Float32Array(R * rows * 3), wallIdx = [];
  const c = new THREE.Color();
  vd.depths = [];
  VOID_BANDS.forEach(([d, hex], k) => {
    vd.depths.push(k ? VOID_BANDS[k - 1][0] : 0, d);
    c.set(hex);
    for (let j = 0; j < 2; j++) for (let i = 0; i < R; i++) col.set([c.r, c.g, c.b], ((2 * k + j) * R + i) * 3);
    for (let i = 0; i < N; i++) { const a = 2 * k * R + i, b = a + R; wallIdx.push(a, a + 1, b, a + 1, b + 1, b); }
  });
  vd.cols = col.slice();                             // the bands' own colours (they darken toward the end)
  wallGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(R * rows * 3), 3).setUsage(THREE.DynamicDrawUsage));
  wallGeo.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
  wallGeo.setIndex(wallIdx);
  vd.wall = new THREE.Mesh(wallGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  vd.wall.renderOrder = -0.5;                        // after the ground's paint and prints (it covers them in the hole)
  for (const m of [vd.ring, vd.wall]) { m.frustumCulled = false; m.visible = false; scene.add(m); }
  // what the reset puts back: the toys, the grass, the paint, the ramp
  if (piles) for (const p of (piles.all = piles.pieces.slice())) { p.homeQ = p.body.quaternion.clone(); }
  if (grass) for (const t of grass.tufts) t.home = { x: t.x, z: t.z, s: t.s };
  if (ramp) ramp.home = ramp.group.quaternion.clone();
}
// the rim's radius at angle th: a circle, slowly breathing
const voidRim = (th) => vd.r * (1 + 0.035 * Math.sin(5 * th + vd.t * 0.7) + 0.02 * Math.sin(9 * th - vd.t * 1.1));
// everything it can take that isn't already going: where it is, how big, and how to place it as it
// goes (y: drop, q: its tilt over the edge, applied on top of how it already sits)
let voidRamp = null;           // the ramp while it's gone (the reset brings it back)
function voidCandidates() {
  const out = [];
  for (const l of llamas) if (l !== player && l.fallen && !l.gone) {
    const g = l.group, base = g.quaternion.clone(), y0 = g.position.y;
    out.push({ x: g.position.x, z: g.position.z, size: 3, mark: () => (l.gone = true),
      set(x, y, z, q) { g.position.set(x, y0 + y, z); g.quaternion.copy(q).multiply(base); } });
  }
  for (const b of balls) if (!b.gone && !b.claimedBy) {
    out.push({ x: b.pos.x, z: b.pos.z, size: 0.4, mark: () => { b.gone = true; removeBall(b); }, done: () => disposeBall(b),
      set(x, y, z, q) { b.g.position.set(x, y, z); b.g.quaternion.copy(q); } });
  }
  if (piles) for (const p of piles.pieces) {
    const m = p.mesh, base = m.quaternion.clone(), y0 = m.position.y;
    out.push({ x: m.position.x, z: m.position.z, size: 0.8,
      mark: () => { piles.pieces.splice(piles.pieces.indexOf(p), 1); piles.world.removeBody(p.body); }, done: () => scene.remove(m),
      set(x, y, z, q) { m.position.set(x, y0 + y, z); m.quaternion.copy(q).multiply(base); } });
  }
  if (grass) for (const t of grass.tufts) if (!t.gone) {
    out.push({ x: t.x, z: t.z, size: 0.6, flat: true, mark: () => (t.gone = true), set(x, y, z) { t.x = x; t.z = z; t.y = y; } });
  }
  if (paint && !paint.gone) {
    const m = paint.blob;
    out.push({ x: m.position.x, z: m.position.z, size: 4, flat: true, mark: () => (paint.gone = true), done: () => (m.visible = false),
      set(x, y, z) { m.position.set(x, 0.01 + y, z); } });
  }
  if (ramp && !ramp.gone && !onRamp(player.group.position.x, player.group.position.z, 1)) {
    const g = ramp.group, base = g.quaternion.clone(), r = ramp;
    out.push({ x: ramp.x, z: ramp.z, size: RAMP_LEN / 2, mark: () => (r.gone = true), done: () => { scene.remove(g); voidRamp = r; ramp = null; },
      set(x, y, z, q) { g.position.set(x, y, z); g.quaternion.copy(q).multiply(base); } });
  }
  return out;
}
function voidStep(dt) {
  if (!VOID || introOn) return;
  const me = player.group.position;
  if (!vd.on) {
    const now = VOID_NOW || params.has('void');
    if (!now && (!blightOn || blight < VOID_AT)) { vd.wait = VOID_WAIT; return; }
    if ((vd.wait -= dt) > 0) return;
    vd.on = voidOpen = true; vd.x = me.x; vd.z = me.z; vd.lx = me.x; vd.lz = me.z; vd.r = 1.5; vd.t = 0;
    vd.ring.visible = vd.wall.visible = true;
    player.setFar(0x000000);                             // its legs go all black
    blightIn.disabled = true;                            // blight: no taking it back now
  }
  vd.t += dt;
  // it grows (more as you walk), and follows your llama (right under it at first, then trailing)
  const walked = Math.hypot(me.x - vd.lx, me.z - vd.lz);
  vd.lx = me.x; vd.lz = me.z;
  if (vd.end < 0) vd.r += ((VOID_GROW + 0.02 * vd.r) * dt + VOID_WALK * walked) * (1 + VOID_RUSH * smooth(0.7, 1, vd.cover)); // (and quickly at the end: no lingering corners)
  const follow = lerp(10, 0.6, smooth(2, 18, vd.r));   // right under it while small, trailing more lazily as it grows
  vd.x = damp(vd.x, me.x, follow, dt); vd.z = damp(vd.z, me.z, follow, dt);
  // reshape the hole and its walls to the rim; near the end, the walls darken to black
  const R = vd.N + 1, ring = vd.ring.geometry.attributes.position, wall = vd.wall.geometry.attributes.position;
  for (let i = 0; i < R; i++) {
    const th = (i / vd.N) * Math.PI * 2, r = voidRim(th), cx = Math.cos(th), sz = Math.sin(th);
    ring.setXYZ(i, vd.x + cx * r, -0.02, vd.z + sz * r);
    ring.setXYZ(R + i, vd.x + cx * (r + 500), -0.02, vd.z + sz * (r + 500));
    vd.depths.forEach((d, j) => wall.setXYZ(j * R + i, vd.x + cx * r, -d, vd.z + sz * r));
  }
  ring.needsUpdate = wall.needsUpdate = true;
  const dark = 1 - smooth(VOID_DARK[0], VOID_DARK[1], vd.cover), col = vd.wall.geometry.attributes.color;
  for (let i = 0; i < col.array.length; i++) col.array[i] = vd.cols[i] * dark;
  col.needsUpdate = true;
  if (actx && sfxOut) sfxOut.gain.setTargetAtTime(SFX_VOL * dark, actx.currentTime, 0.3);  // ...and everything goes quiet
  document.body.classList.toggle('void-ui', vd.cover > VOID_DARK[0]);                   // (the label and controls fade away)
  // a llama still standing where it reaches collapses where it stands
  for (const l of llamas) if (l !== player && !l.fallen && Math.hypot(l.group.position.x - vd.x, l.group.position.z - vd.z) < vd.r) { l.sick = 1; l.keel(); }
  // whatever its edge reaches tips over the brink: it pivots on the rim (gravity pulling it over,
  // slowly at first, then faster), and once it's gone over, falls, still turning
  for (const c of voidCandidates()) {
    const dx = c.x - vd.x, dz = c.z - vd.z, d = Math.hypot(dx, dz);
    if (d > voidRim(Math.atan2(dz, dx)) - c.size * 0.2) continue;
    c.mark();
    const ix = d > 0.01 ? -dx / d : 1, iz = d > 0.01 ? -dz / d : 0, lever = Math.max(0.4, c.size * 0.35);
    vd.falling.push({ c, ix, iz, lever, px: c.x - ix * lever, pz: c.z - iz * lever, th: 0, w: c.flat ? 0 : 0.05,
      free: !!c.flat, x: c.x, y: 0, z: c.z, vx: 0, vy: 0, vz: 0, axis: new THREE.Vector3(iz, 0, -ix) }); // (this axis tips it inward)
  }
  for (let i = vd.falling.length - 1; i >= 0; i--) {
    const f = vd.falling[i];
    if (!f.free) {                                       // tipping on the rim
      f.w += (VOID_FALL / (2 * f.lever)) * Math.sin(f.th + 0.12) * dt;
      f.th += f.w * dt;
      const ct = Math.cos(f.th), st = Math.sin(f.th);
      f.x = f.px + f.ix * f.lever * ct; f.y = -f.lever * st; f.z = f.pz + f.iz * f.lever * ct;
      if (f.th > 1.05) {                                 // over: off it goes, at the speed it was turning
        f.free = true;
        f.vx = -f.ix * f.w * f.lever * st; f.vy = -f.w * f.lever * ct; f.vz = -f.iz * f.w * f.lever * st;
        sfx.gulp?.(_vp.set(f.x, 0, f.z));               // sfx:
      }
    } else {                                             // falling
      f.vy -= VOID_FALL * dt;
      f.x += f.vx * dt; f.y += f.vy * dt; f.z += f.vz * dt; f.th += f.w * dt;
    }
    _vq.setFromAxisAngle(f.axis, f.th);
    f.c.set(f.x, f.y, f.z, _vq);
    if (f.y < -120) { f.c.done?.(); vd.falling.splice(i, 1); }   // well out of sight
  }
  // how much of the view it covers: its radius against the farthest corner of the visible ground
  let far = 0;
  for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    ray.setFromCamera(_vn.set(x, y), camera);
    if (ray.ray.intersectPlane(ground, _vp)) far = Math.max(far, Math.hypot(_vp.x - vd.x, _vp.z - vd.z));
  }
  vd.cover = far ? Math.min(1, vd.r * 0.95 / far) : 0;
  if (vd.cover >= 1 && vd.end < 0) vd.end = 0;          // all black: a moment of it, then the snap
  if (vd.end >= 0 && (vd.end += dt) > VOID_HOLD) voidReset();
}
// back to the title card, with a snap, and a new world behind it (the yellow butterfly flies on)
function voidReset() {
  if (actx) introSnapSound(actx.currentTime + 0.01);
  // the title card, as it was
  introOn = true; introGo = false;
  introEl.classList.remove('go');
  introEl.style.setProperty('--swell', LOGO_START);
  document.body.append(introEl);
  if (flies.length) introFly();
  document.body.classList.remove('void-ui');
  if (actx) { sfxOut.gain.cancelScheduledValues(actx.currentTime); sfxOut.gain.setValueAtTime(0, actx.currentTime); } // (held back until Play)
  // the pit closes
  vd.on = voidOpen = false; vd.wait = VOID_WAIT; vd.r = 0; vd.cover = 0; vd.end = -1; vd.falling.length = 0;
  vd.ring.visible = vd.wall.visible = false;
  // a new herd
  for (const l of llamas.slice(1)) l.dispose();
  llamas.length = 1;
  line.length = 0; renderBubble();
  while (llamas.length < START_HERD) addLlama();
  // your llama, back where it began, unseen until Play
  player.group.position.set(0, 0, 0);
  player.setFar(COATS.black.far);
  hasTarget = false; marker.visible = false; pointerIdle = 0;
  // everything that fell, put back
  for (const b of balls.slice()) { removeBall(b); disposeBall(b); }
  for (const b of loose.splice(0)) disposeBall(b.tr);
  if (voidRamp) { ramp = voidRamp; voidRamp = null; scene.add(ramp.group); }
  if (ramp) { ramp.gone = false; ramp.group.position.set(ramp.x, 0, ramp.z); ramp.group.quaternion.copy(ramp.home); }
  if (piles) {
    for (const p of piles.all) {
      if (!piles.pieces.includes(p)) piles.world.addBody(p.body);
      p.body.position.copy(p.home); p.body.quaternion.copy(p.homeQ);
      p.body.velocity.set(0, 0, 0); p.body.angularVelocity.set(0, 0, 0); p.body.sleep();
      scene.add(p.mesh);
    }
    piles.pieces = piles.all.slice(); piles.fallen = piles.fallen.map(() => false); piles.targets.length = 0;
    syncPiles();
  }
  if (grass) for (const t of grass.tufts) { Object.assign(t, t.home); t.y = 0; t.gone = false; }
  if (paint) { paint.gone = false; paint.blob.visible = true; paint.blob.position.y = 0.01; paint.list.length = 0; }
  // the weather, the blight, the music, all as new
  rainT = -1; rainK = 0; rainWait = RAIN_EVERY[0] + Math.random() * (RAIN_EVERY[1] - RAIN_EVERY[0]);
  blight = 0; blightGlitch = 0; burst.t = 0; burst.wait = 3; pace.t = 0; pace.lastFall = -Infinity;
  if (glitch.snd) { glitchSoundEnd(glitch.snd); glitch.snd = null; burst.own = false; }
  blightIn.disabled = false;
  if (drone) { for (const o of drone.oscs) o.stop(); drone = null; }
  if (musicLP) musicLP.frequency.value = 12000;
  Object.assign(music, { wait: 1.5, deg: 3, n: 0 });
  if (!saved('llama-tune')) { tune = randomTune(); tuneIn.value = Object.keys(TUNES).find((k) => TUNES[k] === tune); } // a new tune for the new round
  // the blue butterfly, back
  for (const fl of flies.slice(1)) if (fl.state === 'gone' || fl.state === 'fall') {
    randomGroundPoint(fl.g.position, { x: 0, z: 0 }, 0); fl.g.position.y = 4; fl.g.visible = true; pickFlight(fl);
  }
}

// ---------- loop ----------
let frozen = false;
if (FIXED_PHASE !== null) {
  // run the simulation forward until the gait settles, then stop exactly at the requested phase
  const dt = 1 / 240;
  for (let i = 0; i < 240 * 4; i++) step(dt);
  for (let i = 0; i < 240 * 4; i++) {
    const before = player.phase;
    step(dt);
    const now = player.phase;
    const crossed = before <= now ? (FIXED_PHASE > before && FIXED_PHASE <= now)
                                  : (FIXED_PHASE > before || FIXED_PHASE <= now);
    if (crossed) break;
  }
  frozen = true;
}

const clock = new THREE.Clock();
const FRAME_MS = 1000 / 60;
let lastFrame = 0;
function tick(now = 0) {
  requestAnimationFrame(tick);
  if (now - lastFrame < FRAME_MS - 2) return; // ~60fps cap
  lastFrame = now;
  const dt = Math.min(clock.getDelta(), 1 / 30) * TIME_SCALE;
  if (!frozen) step(dt);
  for (const l of llamas) l.poseLegs(frozen ? 1 : dt);
  followCamera();
  render();
}
tick();
