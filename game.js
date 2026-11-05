import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";

const $ = (selector) => document.querySelector(selector);
const sceneCanvas = $("#scene");
const loadingScreen = $("#loading");
const startScreen = $("#start-screen");
const endScreen = $("#end-screen");
const hud = $("#hud");
const errorMessage = $("#error-message");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x020504);
scene.fog = new THREE.FogExp2(0x040806, 0.016);

const camera = new THREE.PerspectiveCamera(76, innerWidth / innerHeight, 0.08, 220);
const renderer = new THREE.WebGLRenderer({ canvas: sceneCanvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.06;

// Lua visível no céu (esfera emissiva)
const moonGeom = new THREE.SphereGeometry(4.5, 16, 16);
const moonMat = new THREE.MeshStandardMaterial({
  color: 0xd8e8f0,
  emissive: 0xc8dce8,
  emissiveIntensity: 2.2,
  roughness: 0.9,
  metalness: 0.0,
});
const moonMesh = new THREE.Mesh(moonGeom, moonMat);
moonMesh.position.set(-60, 85, -50);
scene.add(moonMesh);

// Luz ambiente suave – céu levemente esverdeado de floresta
scene.add(new THREE.HemisphereLight(0x7a9c8e, 0x0c1510, 0.42));

// Luz direcional da lua – azul-acinzentado frio, ilumina levemente a floresta
const moonlight = new THREE.DirectionalLight(0xb8ccd8, 0.52);
moonlight.position.set(-60, 85, -50);
moonlight.castShadow = true;
moonlight.shadow.mapSize.set(2048, 2048);
moonlight.shadow.camera.left = -140;
moonlight.shadow.camera.right = 140;
moonlight.shadow.camera.top = 140;
moonlight.shadow.camera.bottom = -140;
moonlight.shadow.camera.near = 10;
moonlight.shadow.camera.far = 280;
moonlight.shadow.bias = -0.0003;
scene.add(moonlight);
scene.add(camera);

const clock = new THREE.Clock();
const loader = new GLTFLoader();
const mixers = [];
const obstacles = [];
const deer = [];
const keys = new Set();
const playerPosition = new THREE.Vector3();
const tempVector = new THREE.Vector3();

// Reserve boundaries: large 232m x 268m area
const worldLimit = { minX: -116, maxX: 116, minZ: -196, maxZ: 72 };
const exitPosition = new THREE.Vector3(0, 0, -195);

const state = {
  phase: "loading",
  elapsed: 0,
  stamina: 100,
  hunterAwake: false,
  hunterPosition: new THREE.Vector3(),
  hunter: null,
  hunterMixer: null,
  hunterAction: null,
  hunterStep: 0,
  hunterBones: null,
  playerStep: 0,
  playerMoving: false,
  flashlight: null,
  cameraPitch: 0,
  exit: null,
  cameraYaw: 0,
  lastMouseX: null,
  lastMouseY: null,
  sound: null,
  audioStarted: false,
  threatDistance: Infinity,
  tremble: 0,
  huntDelay: 0,
  disguisedDeer: null,
};

function seeded(seed) {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}
const random = seeded(48712);

function makeMaterial(color, roughness = 0.95) {
  return new THREE.MeshStandardMaterial({ color, roughness, flatShading: true });
}

function prepareModel(model, desiredHeight, groundCenter = true) {
  const bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  if (size.y === 0) throw new Error("Um modelo 3D não possui altura visível.");
  model.scale.multiplyScalar(desiredHeight / size.y);
  if (groundCenter) {
    model.position.x -= center.x * model.scale.x;
    model.position.z -= center.z * model.scale.z;
    model.position.y -= bounds.min.y * model.scale.y;
  }
  model.traverse((node) => {
    if (node.isMesh) {
      node.castShadow = true;
      node.receiveShadow = true;
      if (node.material) {
        const mats = Array.isArray(node.material) ? node.material : [node.material];
        for (const mat of mats) {
          mat.side = THREE.DoubleSide;
          if (mat.roughness !== undefined) {
            mat.roughness = Math.max(0.65, mat.roughness);
          }
          if (mat.metalness !== undefined) {
            mat.metalness = Math.min(0.12, mat.metalness);
          }
        }
      }
    }
  });
}

function makeCharacterContainer(model, height, position, facing = 0) {
  const container = new THREE.Group();
  prepareModel(model, height);
  model.rotation.y = facing;
  container.add(model);
  container.position.copy(position);
  scene.add(container);
  return container;
}

function spawnDeer(model, position, animationIndex = 0) {
  const copy = cloneSkeleton(model);
  // facing -PI/2 rotaciona a cabeça do deer (+X no modelo) para apontar +Z do container
  // necessário para que Math.atan2(dx, dz) aponte o deer corretamente
  // altura 0.95 = aprox. metade da altura do player (~1.85m)
  const container = makeCharacterContainer(copy, 0.95, position, -Math.PI / 2);
  container.rotation.y = random() * Math.PI * 2;
  const animations = model.userData.animations || [];
  let mixer = null;
  let idleAction = null;
  let walkAction = null;
  if (animations.length) {
    mixer = new THREE.AnimationMixer(copy);
    mixers.push(mixer);
    const idleClip = animations.find((clip) => clip.name.toLowerCase().includes("idle")) || animations[0];
    const walkClip = animations.find((clip) => clip.name.toLowerCase().includes("walk"))
      || animations[animationIndex % animations.length];
    idleAction = mixer.clipAction(idleClip);
    walkAction = mixer.clipAction(walkClip);
    idleAction.play();
  }
  const deerData = {
    container,
    origin: position.clone(),
    phase: random() * Math.PI * 2,
    idleAction,
    walkAction,
    walking: false,
    state: "idle",
    target: null,
    targetAngle: container.rotation.y,
    nextMoveAt: random() * 4 + 2,
  };
  deer.push(deerData);
  return container;
}

function setDeerGait(animal, walking, timeScale = 1.0) {
  animal.walking = walking;
  if (walking) {
    animal.idleAction?.fadeOut(0.25);
    if (animal.walkAction) {
      animal.walkAction.reset().fadeIn(0.25).play();
      animal.walkAction.setEffectiveTimeScale(timeScale);
    }
  } else {
    animal.walkAction?.fadeOut(0.3);
    if (animal.idleAction) {
      animal.idleAction.reset().fadeIn(0.3).play();
    }
  }
}

// Flashlight without distracting artificial arms
function addFirstPersonView() {
  const flashlightBody = new THREE.Mesh(
    new THREE.CylinderGeometry(0.038, 0.052, 0.26, 12),
    new THREE.MeshStandardMaterial({ color: 0x1f241d, metalness: 0.35, roughness: 0.6 }),
  );
  flashlightBody.rotation.x = Math.PI / 2;
  flashlightBody.position.set(0.26, -0.32, -0.45);
  camera.add(flashlightBody);

  const lens = new THREE.Mesh(
    new THREE.CircleGeometry(0.036, 16),
    new THREE.MeshBasicMaterial({ color: 0xffeed2 }),
  );
  lens.position.set(0.26, -0.32, -0.58);
  camera.add(lens);

  const target = new THREE.Object3D();
  target.position.set(0, -0.15, -28);
  camera.add(target);

  // Soft, balanced flashlight beam: projects far without blowing out nearby meshes
  const flashlight = new THREE.SpotLight(0xffedd2, 24, 68, Math.PI / 4.4, 0.82, 1.85);
  flashlight.position.set(0.26, -0.28, -0.42);
  flashlight.target = target;
  flashlight.castShadow = true;
  flashlight.shadow.mapSize.set(1024, 1024);
  flashlight.shadow.camera.near = 0.15;
  flashlight.shadow.camera.far = 55;
  flashlight.shadow.bias = -0.0002;
  camera.add(flashlight);
  state.flashlight = flashlight;

  // Soft ambient fill light so immediate ground isn't pitch black
  const fillLight = new THREE.PointLight(0xffe8c6, 0.7, 10, 2);
  fillLight.position.set(0, -0.2, -0.3);
  camera.add(fillLight);
}

function showLoadProgress(label, ratio) {
  $("#loading-label").textContent = label;
  $("#loading-progress").style.width = `${Math.round(ratio * 100)}%`;
}

function loadGLB(path, label, progressStart, progressSpan) {
  return new Promise((resolve, reject) => {
    loader.load(
      path,
      (gltf) => {
        showLoadProgress(label, progressStart + progressSpan);
        resolve(gltf);
      },
      (event) => {
        if (event.total) {
          const ratio = Math.min(1, event.loaded / event.total);
          $("#loading-progress").style.width = `${Math.round((progressStart + ratio * progressSpan) * 100)}%`;
          $("#loading-label").textContent = label;
        }
      },
      (error) => reject(new Error(`Não foi possível carregar ${path}: ${error.message || "erro de leitura"}`)),
    );
  });
}

// Add environmental reserve fence using the non-door fence segment
function addFence(fenceGLTF) {
  const fMeshMain = fenceGLTF.scene.getObjectByName("01_03_03_0");
  const fMeshPlate = fenceGLTF.scene.getObjectByName("01_03_01_0");
  const fMeshPost = fenceGLTF.scene.getObjectByName("03_03_0");

  if (!fMeshMain) {
    console.warn("Fence mesh 01_03_03_0 not found, skipping fence.");
    return;
  }

  // Pre-configure fence materials for weathered metal look
  for (const mesh of [fMeshMain, fMeshPlate, fMeshPost]) {
    if (!mesh || !mesh.material) continue;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      m.side = THREE.DoubleSide;
      m.roughness = 0.85;
      m.metalness = 0.45;
    }
  }

  // Segment dimensions: height 3.5m, width ~4.59m
  const scale = 3.5 / 395.4;
  const segmentLength = 518.35 * scale; // ~4.59m

  // Compute fence placement coordinates along perimeter
  // West (x = minX), East (x = maxX), South (z = maxZ), North (z = minZ with gate opening)
  const instances = [];

  function addFenceLine(x1, z1, x2, z2) {
    const dx = x2 - x1;
    const dz = z2 - z1;
    const length = Math.hypot(dx, dz);
    const count = Math.ceil(length / segmentLength);
    const angle = Math.atan2(dx, dz);
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count;
      const px = x1 + dx * t;
      const pz = z1 + dz * t;
      instances.push({ x: px, z: pz, angle });
    }
  }

  const { minX, maxX, minZ, maxZ } = worldLimit;

  // West border (running south to north)
  addFenceLine(minX, maxZ, minX, minZ);
  // East border (running south to north)
  addFenceLine(maxX, maxZ, maxX, minZ);
  // South border (back)
  addFenceLine(minX, maxZ, maxX, maxZ);
  // North border (front): left wing from minX to -8, right wing from +8 to maxX (leaving 16m exit gate)
  addFenceLine(minX, minZ, -8, minZ);
  addFenceLine(8, minZ, maxX, minZ);

  const total = instances.length;
  const dummy = new THREE.Object3D();

  const instMain = new THREE.InstancedMesh(fMeshMain.geometry, fMeshMain.material, total);
  const instPlate = fMeshPlate ? new THREE.InstancedMesh(fMeshPlate.geometry, fMeshPlate.material, total) : null;
  const instPost = fMeshPost ? new THREE.InstancedMesh(fMeshPost.geometry, fMeshPost.material, total) : null;

  for (let i = 0; i < total; i++) {
    const { x, z, angle } = instances[i];
    dummy.position.set(x, 0, z);
    dummy.rotation.set(0, angle + Math.PI / 2, 0);
    dummy.scale.set(scale, scale, scale);
    dummy.updateMatrix();

    instMain.setMatrixAt(i, dummy.matrix);
    if (instPlate) instPlate.setMatrixAt(i, dummy.matrix);
    if (instPost) instPost.setMatrixAt(i, dummy.matrix);
  }

  instMain.instanceMatrix.needsUpdate = true;
  instMain.castShadow = true;
  instMain.receiveShadow = true;
  scene.add(instMain);

  if (instPlate) {
    instPlate.instanceMatrix.needsUpdate = true;
    instPlate.castShadow = true;
    instPlate.receiveShadow = true;
    scene.add(instPlate);
  }
  if (instPost) {
    instPost.instanceMatrix.needsUpdate = true;
    instPost.castShadow = true;
    instPost.receiveShadow = true;
    scene.add(instPost);
  }
}

// Add exit gate in the north opening
function addExit() {
  const gate = new THREE.Group();
  gate.position.copy(exitPosition);

  const wood = makeMaterial(0x6b573d, 0.9);
  const postGeometry = new THREE.CylinderGeometry(0.24, 0.32, 6.2, 8);

  for (const x of [-6.8, 6.8]) {
    const post = new THREE.Mesh(postGeometry, wood);
    post.position.set(x, 3.1, 0);
    post.castShadow = true;
    gate.add(post);
  }

  const beam = new THREE.Mesh(new THREE.BoxGeometry(14.8, 0.45, 0.48), wood);
  beam.position.y = 5.95;
  beam.castShadow = true;
  gate.add(beam);

  // Glowing beacon strip
  const glow = new THREE.Mesh(
    new THREE.BoxGeometry(14.4, 0.12, 0.08),
    new THREE.MeshBasicMaterial({ color: 0xccffaa, transparent: true, opacity: 0.95 }),
  );
  glow.position.set(0, 6.25, 0);
  gate.add(glow);

  // Exit lamps
  const lampMaterial = new THREE.MeshBasicMaterial({ color: 0xd6f09e });
  for (const x of [-6.8, 6.8]) {
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.24, 12, 8), lampMaterial);
    lamp.position.set(x, 5.2, 0);
    gate.add(lamp);
    const point = new THREE.PointLight(0xd4f0a0, 2.2, 14, 2);
    point.position.copy(lamp.position);
    gate.add(point);
  }

  const sign = new THREE.Mesh(
    new THREE.BoxGeometry(4.2, 0.8, 0.18),
    makeMaterial(0x283824, 0.9),
  );
  sign.position.set(0, 5.15, 0.3);
  gate.add(sign);

  scene.add(gate);
  state.exit = gate;
}

// Build realistic forest environment using plantsnshii models
function buildEnvironment(firGLTF, oakGLTF, treeGLTF, grassGLTF, fernGLTF) {
  // Ground plane: covers the entire reserve and surrounds
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(320, 360, 1, 1),
    makeMaterial(0x0e140d, 0.98),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, -0.05, -60);
  ground.receiveShadow = true;
  scene.add(ground);

  // Prepare Tree Archetypes from the loaded GLBs
  const archetypes = [];

  // Fir tree variants (LOD1 for high quality & smooth performance)
  const firNames = ["Christmas tree_LOD1", "Christmas tree_2_LOD1", "Christmas tree_4_LOD1"];
  for (const name of firNames) {
    const firNode = firGLTF.scene.getObjectByName(name);
    if (firNode) {
      const template = firNode.clone(true);
      prepareModel(template, 12.5 + random() * 4, true);
      archetypes.push({ model: template, radius: 1.15 });
    }
  }

  // Oak tree variants
  const oakNames = ["Treesmall", "Treemedium", "treelarge"];
  for (const name of oakNames) {
    const oakNode = oakGLTF.scene.getObjectByName(name);
    if (oakNode) {
      const template = oakNode.clone(true);
      prepareModel(template, 11 + random() * 4.5, true);
      archetypes.push({ model: template, radius: 1.25 });
    }
  }

  // Broadleaf tree from tree.glb
  const broadleafNode = treeGLTF.scene.getObjectByName("raw2.obj.cleaner.gles") || treeGLTF.scene;
  if (broadleafNode) {
    const template = broadleafNode.clone(true);
    prepareModel(template, 9.5, true);
    archetypes.push({ model: template, radius: 0.95 });
  }

  // Place ~300 trees throughout the nature reserve
  const treeCount = 310;
  for (let i = 0; i < treeCount; i++) {
    const x = -106 + random() * 212;
    const z = -186 + random() * 248;

    // Keep exit path clear
    if (Math.hypot(x - exitPosition.x, z - exitPosition.z) < 16) continue;

    const arch = archetypes[Math.floor(random() * archetypes.length)];
    if (!arch) continue;

    const scale = 0.82 + random() * 0.42;
    const tree = arch.model.clone(true);
    tree.scale.multiplyScalar(scale);
    tree.rotation.y = random() * Math.PI * 2;
    tree.position.set(x, 0, z);
    scene.add(tree);

    obstacles.push({ x, z, radius: arch.radius * scale });
  }

  // Add realistic 3D Grass clumps using InstancedMesh
  const grassMesh = grassGLTF.scene.getObjectByName("Grass1_Grass_Mat_0") || grassGLTF.scene.getObjectByName("Grass1");
  if (grassMesh && grassMesh.isMesh) {
    const grassGeo = grassMesh.geometry;
    const grassMat = grassMesh.material;
    if (grassMat) grassMat.side = THREE.DoubleSide;

    const grassCount = 340;
    const instGrass = new THREE.InstancedMesh(grassGeo, grassMat, grassCount);
    const helper = new THREE.Object3D();
    const gScale = 0.009; // scale model units to world meters

    for (let i = 0; i < grassCount; i++) {
      const gx = -110 + random() * 220;
      const gz = -188 + random() * 252;
      const s = gScale * (0.8 + random() * 0.6);
      helper.position.set(gx, 0, gz);
      helper.rotation.set(0, random() * Math.PI * 2, 0);
      helper.scale.set(s, s, s);
      helper.updateMatrix();
      instGrass.setMatrixAt(i, helper.matrix);
    }
    instGrass.instanceMatrix.needsUpdate = true;
    instGrass.receiveShadow = true;
    scene.add(instGrass);
  }

  // Add realistic 3D Ferns using InstancedMesh
  const fernMesh = fernGLTF.scene.getObjectByName("Object_2");
  if (fernMesh && fernMesh.isMesh) {
    const fernGeo = fernMesh.geometry;
    const fernMat = fernMesh.material;
    if (fernMat) fernMat.side = THREE.DoubleSide;

    const fernCount = 220;
    const instFern = new THREE.InstancedMesh(fernGeo, fernMat, fernCount);
    const helper = new THREE.Object3D();

    for (let i = 0; i < fernCount; i++) {
      const fx = -108 + random() * 216;
      const fz = -186 + random() * 250;
      const s = 0.45 + random() * 0.45;
      helper.position.set(fx, 0, fz);
      helper.rotation.set(0, random() * Math.PI * 2, 0);
      helper.scale.set(s, s, s);
      helper.updateMatrix();
      instFern.setMatrixAt(i, helper.matrix);
    }
    instFern.instanceMatrix.needsUpdate = true;
    instFern.receiveShadow = true;
    scene.add(instFern);
  }

  // Add natural mossy rocks
  const rockMaterial = makeMaterial(0x384033, 0.95);
  const rockMatrices = [];
  const helper = new THREE.Object3D();
  for (let i = 0; i < 75; i++) {
    const rx = -108 + random() * 216;
    const rz = -186 + random() * 250;
    const s = 0.5 + random() * 1.1;
    helper.position.set(rx, 0.35 * s, rz);
    helper.scale.set(1.4 * s, 0.8 * s, s);
    helper.rotation.set(random(), random(), random());
    helper.updateMatrix();
    rockMatrices.push(helper.matrix.clone());
    obstacles.push({ x: rx, z: rz, radius: 1.1 * s });
  }
  const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), rockMaterial, rockMatrices.length);
  rockMatrices.forEach((mat, idx) => rocks.setMatrixAt(idx, mat));
  rocks.instanceMatrix.needsUpdate = true;
  rocks.castShadow = true;
  rocks.receiveShadow = true;
  scene.add(rocks);
}

function hitsObstacle(x, z) {
  return obstacles.some((obstacle) => {
    const dx = x - obstacle.x;
    const dz = z - obstacle.z;
    const threshold = obstacle.radius + 0.72;
    return dx * dx + dz * dz < threshold * threshold;
  });
}

function randomForestPoint({
  playerDistance = 0,
  exitDistance = 0,
  existing = [],
  existingDistance = 0,
} = {}) {
  for (let attempt = 0; attempt < 900; attempt += 1) {
    const point = new THREE.Vector3(
      worldLimit.minX + 8 + Math.random() * (worldLimit.maxX - worldLimit.minX - 16),
      0,
      worldLimit.minZ + 8 + Math.random() * (worldLimit.maxZ - worldLimit.minZ - 16),
    );
    if (point.distanceTo(exitPosition) < exitDistance) continue;
    if (point.distanceTo(playerPosition) < playerDistance) continue;
    if (existing.some((other) => point.distanceTo(other) < existingDistance)) continue;
    if (hitsObstacle(point.x, point.z)) continue;
    return point;
  }
  // Safe fallback
  return new THREE.Vector3(0, 0, 0);
}

function chooseDeerTarget(animal) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const angle = Math.random() * Math.PI * 2;
    const distance = 8 + Math.random() * 14;
    const target = new THREE.Vector3(
      THREE.MathUtils.clamp(animal.container.position.x + Math.cos(angle) * distance, worldLimit.minX + 6, worldLimit.maxX - 6),
      0,
      THREE.MathUtils.clamp(animal.container.position.z + Math.sin(angle) * distance, worldLimit.minZ + 6, worldLimit.maxZ - 6),
    );
    if (hitsObstacle(target.x, target.z)) continue;
    const crowded = deer.some((other) =>
      other !== animal && other.container.visible && other.container.position.distanceTo(target) < 4.2,
    );
    if (crowded) continue;

    const travel = target.clone().sub(animal.container.position);
    const steps = Math.ceil(travel.length() / 1.5);
    let blocked = false;
    for (let step = 1; step <= steps; step += 1) {
      const sample = animal.container.position.clone().addScaledVector(travel, step / steps);
      if (hitsObstacle(sample.x, sample.z)) {
        blocked = true;
        break;
      }
    }
    if (!blocked) return target;
  }
  return null;
}

function createWorld(deerModel, monsterGLTF) {
  const start = randomForestPoint({ exitDistance: 80 });
  playerPosition.copy(start);
  addFirstPersonView();

  const positions = [];
  const totalDeer = 38;
  for (let index = 0; index < totalDeer; index += 1) {
    positions.push(randomForestPoint({
      playerDistance: 14,
      exitDistance: 20,
      existing: positions,
      existingDistance: 8,
    }));
  }

  const disguisedIndex = Math.floor(Math.random() * positions.length);
  const disguised = spawnDeer(deerModel, positions[disguisedIndex], disguisedIndex);
  state.disguisedDeer = deer.find((animal) => animal.container === disguised);

  for (let index = 0; index < positions.length; index += 1) {
    if (index !== disguisedIndex) spawnDeer(deerModel, positions[index], index);
  }

  const monsterModel = monsterGLTF.scene;
  state.hunterPosition.copy(positions[disguisedIndex]);
  // facing 0 aligns natively
  state.hunter = makeCharacterContainer(monsterModel, 3.2, positions[disguisedIndex], 0);
  state.hunter.visible = false;

  // Cache monster skeleton bones for dynamic chase animations
  state.hunterBones = {
    hip: monsterModel.getObjectByName("C_Hip_J_00"),
    leftThigh: monsterModel.getObjectByName("L_upper_leg_J_072"),
    leftKnee: monsterModel.getObjectByName("L_knee_J_073"),
    leftAnkle: monsterModel.getObjectByName("L_ankle_J_074"),
    rightThigh: monsterModel.getObjectByName("R_upper_leg_J_078"),
    rightKnee: monsterModel.getObjectByName("R_knee_J_079"),
    rightAnkle: monsterModel.getObjectByName("R_ankle_J_080"),
    spine1: monsterModel.getObjectByName("C_spine_01_J_018"),
    spine2: monsterModel.getObjectByName("C_spine_02_J_019"),
    spine3: monsterModel.getObjectByName("C_spine_03_J_020"),
    neck: monsterModel.getObjectByName("C_Neck_J_022"),
    head: monsterModel.getObjectByName("C_Head_J_023"),
    jaw: monsterModel.getObjectByName("C_jaw__J_026"),
    leftShoulder: monsterModel.getObjectByName("L_shoulder_J_034"),
    leftElbow: monsterModel.getObjectByName("L_elbow_J_035"),
    rightShoulder: monsterModel.getObjectByName("R_shoulder_J_053"),
    rightElbow: monsterModel.getObjectByName("R_elbow_J_054"),
    tail1: monsterModel.getObjectByName("C_Bone_tail_01_J_04"),
    tail5: monsterModel.getObjectByName("C_Bone_tail_05_J_08"),
  };

  for (const bone of Object.values(state.hunterBones)) {
    if (bone) {
      bone.userData.restQ = bone.quaternion.clone();
      bone.userData.restRot = bone.rotation.clone();
    }
  }

  if (monsterGLTF.animations.length) {
    state.hunterMixer = new THREE.AnimationMixer(monsterModel);
    state.hunterAction = state.hunterMixer.clipAction(monsterGLTF.animations[0]);
  }
}

function startAudio() {
  if (state.audioStarted) return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  const context = new AudioContext();
  const master = context.createGain();
  master.gain.value = 0.14;
  master.connect(context.destination);

  const low = context.createOscillator();
  const lowGain = context.createGain();
  low.type = "sine";
  low.frequency.value = 46;
  lowGain.gain.value = 0.24;
  low.connect(lowGain);
  lowGain.connect(master);
  low.start();

  const wind = context.createOscillator();
  const windGain = context.createGain();
  const filter = context.createBiquadFilter();
  wind.type = "sawtooth";
  wind.frequency.value = 88;
  filter.type = "lowpass";
  filter.frequency.value = 210;
  windGain.gain.value = 0.045;
  wind.connect(filter);
  filter.connect(windGain);
  windGain.connect(master);
  wind.start();

  state.sound = { context, master, low, lowGain, wind };
  state.audioStarted = true;
}

function startGame() {
  if (state.phase !== "ready" && state.phase !== "ended") return;
  startAudio();
  state.phase = "playing";
  state.elapsed = 0;
  state.stamina = 100;
  state.hunterAwake = false;
  state.huntDelay = 0;
  state.tremble = 0;
  state.playerStep = 0;
  state.cameraYaw = Math.random() * Math.PI * 2;
  playerPosition.copy(randomForestPoint({
    exitDistance: 80,
    existing: deer.map((animal) => animal.origin),
    existingDistance: 14,
  }));
  state.cameraPitch = 0;
  state.hunter.visible = false;

  deer.forEach((animal) => {
    const { container, origin, idleAction, walkAction } = animal;
    container.visible = true;
    container.position.copy(origin);
    container.rotation.y = Math.random() * Math.PI * 2;
    container.rotation.z = 0;
    if (walkAction) walkAction.stop();
    if (idleAction) {
      idleAction.reset();
      idleAction.play();
    }
    animal.walking = false;
    animal.state = "idle";
    animal.target = null;
    animal.targetAngle = container.rotation.y;
    animal.nextMoveAt = 1.5 + Math.random() * 3.5;
  });

  state.hunterStep = 0;
  state.hunterPosition.copy(state.disguisedDeer.container.position);
  state.hunter.position.copy(state.hunterPosition);
  state.hunter.position.y = 0;
  state.hunter.rotation.set(0, 0, 0);
  if (state.hunterBones) {
    for (const bone of Object.values(state.hunterBones)) {
      if (bone?.userData?.restQ) bone.quaternion.copy(bone.userData.restQ);
    }
  }
  if (state.hunterMixer && state.hunterAction) {
    state.hunterMixer.stopAllAction();
  }

  startScreen.classList.add("hidden");
  endScreen.classList.add("hidden");
  $("#pause-indicator").classList.add("hidden");
  hud.classList.remove("hidden");
  $("#crosshair").classList.remove("hidden");
  $("#threat-card").classList.remove("alert");
  $("#threat-text").textContent = "A floresta está quieta demais.";
  $("#warning-banner").classList.remove("visible");
  $("#objective-text").textContent = "Encontre a saída da reserva florestal";
  $("#exit-marker").classList.add("hidden");
  $("#stamina-caption").textContent = "Guarde energia. Você vai precisar.";

  if (state.sound) {
    const now = state.sound.context.currentTime;
    state.sound.lowGain.gain.setTargetAtTime(0.24, now, 0.3);
    state.sound.master.gain.setTargetAtTime(0.14, now, 0.3);
  }
  updateHUD();
}

function endGame(won) {
  if (state.phase !== "playing") return;
  state.phase = "ended";
  if (document.pointerLockElement) document.exitPointerLock();
  endScreen.classList.remove("hidden", "lost");
  hud.classList.add("hidden");
  $("#crosshair").classList.add("hidden");
  if (won) {
    $("#end-eyebrow").textContent = "VOCÊ ESCAPOU DA RESERVA AMBIENTAL";
    $("#end-title").innerHTML = "VOCÊ<br /><span>CONSEGUIU.</span>";
    $("#end-message").textContent = "O portão ficou para trás. A floresta volta a guardar seus segredos.";
  } else {
    endScreen.classList.add("lost");
    $("#end-eyebrow").textContent = "A RESERVA COBROU O SEU PREÇO";
    $("#end-title").textContent = "voce nao conseguiu escapar";
    $("#end-message").textContent = "A floresta ficou em silêncio outra vez.";
  }
}

function setPaused(paused) {
  if (paused && state.phase === "playing") {
    state.phase = "paused";
    $("#pause-indicator").classList.remove("hidden");
  } else if (!paused && state.phase === "paused") {
    state.phase = "playing";
    $("#pause-indicator").classList.add("hidden");
    clock.getDelta();
  }
}

function updateHUD() {
  const percentage = Math.round(state.stamina);
  $("#stamina-value").textContent = `${percentage}%`;
  $("#stamina-fill").style.width = `${percentage}%`;
  $("#stamina-fill").classList.toggle("low", percentage < 27);
  $("#timer").textContent = `${String(Math.floor(state.elapsed / 60)).padStart(2, "0")}:${String(Math.floor(state.elapsed % 60)).padStart(2, "0")}`;
  if (state.hunterAwake) {
    const hunterDistance = state.hunterPosition.distanceTo(playerPosition);
    $("#threat-text").textContent = hunterDistance < 14 ? "Está logo atrás de você. CORRA!" : "Ele está caçando você. Não olhe para trás!";
  }
}

function awakenHunter() {
  if (state.hunterAwake) return;
  state.hunterAwake = true;
  state.hunter.visible = true;
  state.hunterPosition.copy(state.disguisedDeer.container.position);
  state.hunter.position.copy(state.hunterPosition);
  state.disguisedDeer.container.visible = false;
  state.disguisedDeer.idleAction?.stop();
  state.disguisedDeer.walkAction?.stop();
  state.hunterStep = 0;
  if (state.hunterAction) {
    state.hunterAction.reset().play();
  }

  $("#threat-card").classList.add("alert");
  $("#threat-text").textContent = "ELE PERCEBEU VOCÊ!";
  $("#objective-text").textContent = "CORRA até o portão de saída!";
  $("#warning-banner").classList.add("visible");
  $("#exit-marker").classList.remove("hidden");
  $("#stamina-caption").textContent = "Segure SHIFT para correr!";
  window.setTimeout(() => $("#warning-banner").classList.remove("visible"), 2600);

  state.tremble = 2.6;
  state.huntDelay = 1.6;
  if (state.sound) {
    const now = state.sound.context.currentTime;
    state.sound.lowGain.gain.cancelScheduledValues(now);
    state.sound.lowGain.gain.setTargetAtTime(0.8, now, 0.18);
    state.sound.master.gain.setTargetAtTime(0.28, now, 0.25);
    const alarm = state.sound.context.createOscillator();
    const gain = state.sound.context.createGain();
    alarm.type = "sawtooth";
    alarm.frequency.setValueAtTime(140, now);
    alarm.frequency.exponentialRampToValueAtTime(72, now + 1.4);
    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 1.5);
    alarm.connect(gain);
    gain.connect(state.sound.master);
    alarm.start(now);
    alarm.stop(now + 1.55);
  }
}

function updatePlayer(delta) {
  let forwardInput = Number(keys.has("KeyW") || keys.has("ArrowUp"))
    - Number(keys.has("KeyS") || keys.has("ArrowDown"));
  let sideInput = Number(keys.has("KeyD") || keys.has("ArrowRight"))
    - Number(keys.has("KeyA") || keys.has("ArrowLeft"));
  const inputLength = Math.hypot(forwardInput, sideInput);
  if (inputLength) {
    forwardInput /= inputLength;
    sideInput /= inputLength;
  }
  const sprinting = inputLength > 0 && (keys.has("ShiftLeft") || keys.has("ShiftRight")) && state.stamina > 0;
  const speed = sprinting ? 7.35 : 4.35;
  if (sprinting) state.stamina = Math.max(0, state.stamina - delta * 20);
  else state.stamina = Math.min(100, state.stamina + delta * (inputLength ? 13 : 20));

  const forwardX = -Math.sin(state.cameraYaw);
  const forwardZ = -Math.cos(state.cameraYaw);
  const rightX = Math.cos(state.cameraYaw);
  const rightZ = -Math.sin(state.cameraYaw);
  const dx = (forwardX * forwardInput + rightX * sideInput) * speed * delta;
  const dz = (forwardZ * forwardInput + rightZ * sideInput) * speed * delta;

  const nextX = playerPosition.x + dx;
  const nextZ = playerPosition.z + dz;

  // Collision with environmental fence boundaries
  let blockX = false;
  let blockZ = false;

  if (nextX < worldLimit.minX + 1.2 || nextX > worldLimit.maxX - 1.2) blockX = true;
  if (nextZ > worldLimit.maxZ - 1.2) blockZ = true;

  // North fence: allows passing only through the 16m gate gap (|x| < 7.5)
  if (nextZ < worldLimit.minZ + 1.2) {
    if (Math.abs(playerPosition.x) > 7.5 || Math.abs(nextX) > 7.5) {
      blockZ = true;
    }
  }

  if (!blockX && !hitsObstacle(nextX, playerPosition.z)) playerPosition.x = nextX;
  if (!blockZ && !hitsObstacle(playerPosition.x, nextZ)) playerPosition.z = nextZ;

  state.playerMoving = inputLength > 0;
  const stepSpeed = sprinting ? 13 : 8;
  if (state.playerMoving) state.playerStep += delta * stepSpeed;
  else state.playerStep = THREE.MathUtils.damp(state.playerStep, 0, 6, delta);
}

function updateHunter(delta) {
  if (!state.hunterAwake) {
    if (playerPosition.distanceTo(state.disguisedDeer.container.position) < 7.2) awakenHunter();
    return;
  }

  const bones = state.hunterBones;

  if (state.huntDelay > 0) {
    state.huntDelay = Math.max(0, state.huntDelay - delta);
    state.hunterMixer?.update(delta);
    // Roaring pose while transforming
    if (bones?.spine1) {
      bones.spine1.quaternion.copy(bones.spine1.userData.restQ);
      bones.spine1.rotateX(-0.25);
    }
    if (bones?.jaw) {
      bones.jaw.quaternion.copy(bones.jaw.userData.restQ);
      bones.jaw.rotateX(0.65);
    }
    return;
  }

  // Once chase starts, stop idle action so it doesn't freeze the bones
  if (state.hunterAction?.isRunning()) {
    state.hunterAction.stop();
  }

  tempVector.subVectors(playerPosition, state.hunterPosition);
  const distance = tempVector.length();
  state.threatDistance = distance;

  if (distance > 0.01) {
    tempVector.normalize();
    const pace = distance > 14 ? 6.1 : 6.35;
    state.hunterPosition.addScaledVector(tempVector, Math.min(distance - 1.5, pace * delta));

    // Dynamic footstep stride
    state.hunterStep += delta * 13;
    const stride = Math.sin(state.hunterStep);
    const bounce = Math.abs(Math.sin(state.hunterStep)) * 0.22;

    // Contact with the ground: bouncy predatory sprint
    state.hunter.position.set(state.hunterPosition.x, bounce, state.hunterPosition.z);

    // Face player, tilt forward into chase, roll side-to-side
    const faceAngle = Math.atan2(-tempVector.x, -tempVector.z);
    state.hunter.rotation.order = "YXZ";
    state.hunter.rotation.set(
      0.22 + Math.sin(state.hunterStep * 2) * 0.04,
      faceAngle,
      Math.sin(state.hunterStep) * 0.07,
    );

    // Animate skeleton joints
    if (bones) {
      // 1. Thighs: wide alternating strides
      const thighAngle = stride * 0.72;
      if (bones.leftThigh) {
        bones.leftThigh.quaternion.copy(bones.leftThigh.userData.restQ);
        bones.leftThigh.rotateZ(thighAngle);
      }
      if (bones.rightThigh) {
        bones.rightThigh.quaternion.copy(bones.rightThigh.userData.restQ);
        bones.rightThigh.rotateZ(-thighAngle);
      }

      // 2. Knees: bend backwards when leg is trailing
      if (bones.leftKnee) {
        bones.leftKnee.quaternion.copy(bones.leftKnee.userData.restQ);
        bones.leftKnee.rotateZ(Math.max(0, -stride) * 1.05);
      }
      if (bones.rightKnee) {
        bones.rightKnee.quaternion.copy(bones.rightKnee.userData.restQ);
        bones.rightKnee.rotateZ(Math.max(0, stride) * 1.05);
      }

      // 3. Ankles: flex on touchdown
      if (bones.leftAnkle) {
        bones.leftAnkle.quaternion.copy(bones.leftAnkle.userData.restQ);
        bones.leftAnkle.rotateZ(Math.sin(state.hunterStep) * 0.35);
      }
      if (bones.rightAnkle) {
        bones.rightAnkle.quaternion.copy(bones.rightAnkle.userData.restQ);
        bones.rightAnkle.rotateZ(-Math.sin(state.hunterStep) * 0.35);
      }

      // 4. Arms & Claws: reach forward aggressively, slashing with each step
      if (bones.leftShoulder) {
        bones.leftShoulder.quaternion.copy(bones.leftShoulder.userData.restQ);
        bones.leftShoulder.rotateZ(-thighAngle * 0.75);
        bones.leftShoulder.rotateX(0.42);
      }
      if (bones.rightShoulder) {
        bones.rightShoulder.quaternion.copy(bones.rightShoulder.userData.restQ);
        bones.rightShoulder.rotateZ(thighAngle * 0.75);
        bones.rightShoulder.rotateX(0.42);
      }
      if (bones.leftElbow) {
        bones.leftElbow.quaternion.copy(bones.leftElbow.userData.restQ);
        bones.leftElbow.rotateZ(0.55 + Math.sin(state.hunterStep) * 0.3);
      }
      if (bones.rightElbow) {
        bones.rightElbow.quaternion.copy(bones.rightElbow.userData.restQ);
        bones.rightElbow.rotateZ(0.55 - Math.sin(state.hunterStep) * 0.3);
      }

      // 5. Spine: hunched predatory curve with torso twist
      if (bones.spine1) {
        bones.spine1.quaternion.copy(bones.spine1.userData.restQ);
        bones.spine1.rotateX(0.3);
        bones.spine1.rotateY(stride * 0.14);
      }
      if (bones.spine3) {
        bones.spine3.quaternion.copy(bones.spine3.userData.restQ);
        bones.spine3.rotateX(0.18);
      }

      // 6. Neck & Head: lunging forward, menacing twitches
      if (bones.neck) {
        bones.neck.quaternion.copy(bones.neck.userData.restQ);
        bones.neck.rotateX(-0.16);
      }
      if (bones.head) {
        bones.head.quaternion.copy(bones.head.userData.restQ);
        bones.head.rotateX(Math.sin(state.hunterStep * 2) * 0.1);
        bones.head.rotateY(Math.sin(state.elapsed * 7.5) * 0.08);
      }

      // 7. Jaw: snaps hungrily
      if (bones.jaw) {
        bones.jaw.quaternion.copy(bones.jaw.userData.restQ);
        bones.jaw.rotateX(Math.max(0, Math.sin(state.hunterStep * 1.5)) * 0.45);
      }

      // 8. Tail: whips aggressively behind
      if (bones.tail1) {
        bones.tail1.quaternion.copy(bones.tail1.userData.restQ);
        bones.tail1.rotateZ(Math.sin(state.hunterStep) * 0.38);
      }
      if (bones.tail5) {
        bones.tail5.quaternion.copy(bones.tail5.userData.restQ);
        bones.tail5.rotateZ(Math.sin(state.hunterStep - 0.4) * 0.45);
      }
    }
  }

  if (distance < 2.15) endGame(false);
}

function updateCamera(delta) {
  if (state.tremble > 0 && state.hunterAwake) {
    state.tremble = Math.max(0, state.tremble - delta);
  }
  const walkBob = state.playerMoving ? Math.abs(Math.sin(state.playerStep * 0.5)) * 0.055 : 0;
  const runShake = state.playerMoving && (keys.has("ShiftLeft") || keys.has("ShiftRight")) ? Math.sin(state.playerStep * 2) * 0.012 : 0;
  const fearShake = state.hunterAwake && state.threatDistance < 14 ? 0.012 : 0;

  camera.position.set(
    playerPosition.x,
    playerPosition.y + 1.63 + walkBob + (random() - 0.5) * (fearShake + (state.tremble > 0 ? 0.035 : 0)),
    playerPosition.z,
  );
  camera.rotation.order = "YXZ";
  camera.rotation.set(
    state.cameraPitch + runShake,
    state.cameraYaw,
    (random() - 0.5) * fearShake,
  );
}

function updateDeer(delta) {
  // Distância de alerta reduzida: deer só fogem quando o player chega bem perto
  // 10m correndo (sprint), 7m andando normal
  const alertDistance = (keys.has("ShiftLeft") || keys.has("ShiftRight")) && state.playerMoving ? 10 : 7;

  for (const animal of deer) {
    if (!animal.container.visible) continue;

    const distToPlayer = animal.container.position.distanceTo(playerPosition);
    const isDisguised = animal === state.disguisedDeer;

    // Fleeing trigger: normal deer flee from player when too close
    if (!isDisguised && animal.state !== "fleeing") {
      if (distToPlayer < alertDistance) {
        animal.state = "fleeing";
        const awayDir = new THREE.Vector3()
          .subVectors(animal.container.position, playerPosition)
          .setY(0)
          .normalize();
        const spread = (animal.phase - Math.PI) * 0.45;
        awayDir.applyAxisAngle(new THREE.Vector3(0, 1, 0), spread);

        const fleeDist = 32 + Math.random() * 14;
        let tx = animal.container.position.x + awayDir.x * fleeDist;
        let tz = animal.container.position.z + awayDir.z * fleeDist;
        tx = THREE.MathUtils.clamp(tx, worldLimit.minX + 6, worldLimit.maxX - 6);
        tz = THREE.MathUtils.clamp(tz, worldLimit.minZ + 6, worldLimit.maxZ - 6);

        animal.target = new THREE.Vector3(tx, 0, tz);
        setDeerGait(animal, true, 1.9); // sprint animation
      }
    }

    if (animal.state === "fleeing") {
      if (animal.target) {
        tempVector.subVectors(animal.target, animal.container.position);
        const distToTarget = tempVector.length();

        if (distToTarget < 1.2 || (distToPlayer > 28 && distToTarget < 6)) {
          // Reached safe zone
          animal.state = "idle";
          setDeerGait(animal, false);
          animal.target = null;
          animal.nextMoveAt = state.elapsed + 2.5 + Math.random() * 3.5;
        } else {
          tempVector.normalize();
          // Head faces movement direction
          const desiredAngle = Math.atan2(tempVector.x, tempVector.z);

          let angleDiff = (desiredAngle - animal.container.rotation.y) % (Math.PI * 2);
          if (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
          if (angleDiff > Math.PI) angleDiff -= Math.PI * 2;

          const turnRate = 7.5;
          const turnStep = Math.sign(angleDiff) * Math.min(Math.abs(angleDiff), turnRate * delta);
          animal.container.rotation.y += turnStep;

          // Dynamic bank into turns
          const bank = -Math.sign(angleDiff) * Math.min(0.12, Math.abs(angleDiff) * 0.16);
          animal.container.rotation.z = THREE.MathUtils.damp(animal.container.rotation.z, bank, 6, delta);

          // Realistic turning: slow down translation during sharp turns
          const turnAlignment = Math.max(0.18, Math.cos(angleDiff));
          const runSpeed = 6.8 * turnAlignment;
          const travel = Math.min(distToTarget, runSpeed * delta);

          const nextX = animal.container.position.x + tempVector.x * travel;
          const nextZ = animal.container.position.z + tempVector.z * travel;

          if (hitsObstacle(nextX, nextZ)) {
            animal.target = chooseDeerTarget(animal);
          } else {
            animal.container.position.x = nextX;
            animal.container.position.z = nextZ;
          }
        }
      }
    } else if (animal.state === "walking") {
      // Gentle roaming
      if (animal.target) {
        tempVector.subVectors(animal.target, animal.container.position);
        const distToTarget = tempVector.length();

        if (distToTarget < 0.5) {
          animal.state = "idle";
          setDeerGait(animal, false);
          animal.target = null;
          animal.nextMoveAt = state.elapsed + 2.0 + Math.random() * 4.0;
        } else {
          tempVector.normalize();
          const desiredAngle = Math.atan2(tempVector.x, tempVector.z);

          let angleDiff = (desiredAngle - animal.container.rotation.y) % (Math.PI * 2);
          if (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
          if (angleDiff > Math.PI) angleDiff -= Math.PI * 2;

          const turnRate = 3.6;
          const turnStep = Math.sign(angleDiff) * Math.min(Math.abs(angleDiff), turnRate * delta);
          animal.container.rotation.y += turnStep;
          animal.container.rotation.z = THREE.MathUtils.damp(animal.container.rotation.z, 0, 5, delta);

          const turnAlignment = Math.max(0.2, Math.cos(angleDiff));
          const walkSpeed = 2.0 * turnAlignment;
          const travel = Math.min(distToTarget, walkSpeed * delta);

          const nextX = animal.container.position.x + tempVector.x * travel;
          const nextZ = animal.container.position.z + tempVector.z * travel;

          if (hitsObstacle(nextX, nextZ)) {
            animal.state = "idle";
            setDeerGait(animal, false);
            animal.target = null;
            animal.nextMoveAt = state.elapsed + 1.0 + Math.random() * 2.0;
          } else {
            animal.container.position.x = nextX;
            animal.container.position.z = nextZ;
          }
        }
      }
    } else {
      // Idle state
      animal.container.rotation.z = THREE.MathUtils.damp(animal.container.rotation.z, 0, 4, delta);
      animal.container.rotation.y += Math.sin(state.elapsed * 0.9 + animal.phase) * 0.002;

      if (state.elapsed >= animal.nextMoveAt) {
        animal.target = chooseDeerTarget(animal);
        if (animal.target) {
          animal.state = "walking";
          setDeerGait(animal, true, 1.15);
        } else {
          animal.nextMoveAt = state.elapsed + 1.5 + Math.random() * 2.5;
        }
      }
    }
  }

  for (const mixer of mixers) mixer.update(delta);
}

function frame() {
  requestAnimationFrame(frame);
  const delta = Math.min(clock.getDelta(), 0.05);
  if (state.phase === "playing") {
    state.elapsed += delta;
    updatePlayer(delta);
    updateHunter(delta);
    updateDeer(delta);
    updateCamera(delta);
    if (playerPosition.distanceTo(exitPosition) < 6.5) endGame(true);
    if (Math.floor(state.elapsed * 5) !== Math.floor((state.elapsed - delta) * 5)) updateHUD();
  } else {
    updateDeer(delta);
    updateCamera(delta);
  }
  renderer.render(scene, camera);
}

function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.setSize(innerWidth, innerHeight);
}

function attachControls() {
  $("#start-button").addEventListener("click", startGame);
  $("#restart-button").addEventListener("click", startGame);
  window.addEventListener("keydown", (event) => {
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(event.code)) event.preventDefault();
    keys.add(event.code);
    if (event.code === "Escape") setPaused(state.phase !== "paused");
  });
  window.addEventListener("keyup", (event) => keys.delete(event.code));
  window.addEventListener("blur", () => keys.clear());
  window.addEventListener("resize", resize);
  sceneCanvas.addEventListener("pointerdown", (event) => {
    state.lastMouseX = event.clientX;
    state.lastMouseY = event.clientY;
    if (event.pointerType !== "mouse") sceneCanvas.setPointerCapture(event.pointerId);
  });
  sceneCanvas.addEventListener("pointermove", (event) => {
    if (state.phase !== "playing" || document.pointerLockElement === sceneCanvas || !(event.buttons & 1)) return;
    if (state.lastMouseX !== null) {
      state.cameraYaw -= (event.clientX - state.lastMouseX) * 0.003;
      state.cameraPitch = THREE.MathUtils.clamp(
        state.cameraPitch - (event.clientY - state.lastMouseY) * 0.003,
        -1.05,
        1.05,
      );
    }
    state.lastMouseX = event.clientX;
    state.lastMouseY = event.clientY;
  });
  sceneCanvas.addEventListener("pointerup", () => {
    state.lastMouseX = null;
    state.lastMouseY = null;
  });
  sceneCanvas.addEventListener("pointercancel", () => {
    state.lastMouseX = null;
    state.lastMouseY = null;
  });
  document.querySelectorAll(".joystick-grid button").forEach((button) => {
    const code = button.dataset.key;
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      keys.add(code);
      button.setPointerCapture(event.pointerId);
    });
    const release = () => keys.delete(code);
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("lostpointercapture", release);
  });
  const sprintButton = $("#sprint-button");
  sprintButton.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    keys.add("ShiftLeft");
    sprintButton.setPointerCapture(event.pointerId);
  });
  sprintButton.addEventListener("pointerup", () => keys.delete("ShiftLeft"));
  sprintButton.addEventListener("pointercancel", () => keys.delete("ShiftLeft"));
}

async function initialize() {
  attachControls();
  addExit();
  showLoadProgress("Carregando os cervos da reserva...", 0);

  try {
    const deerGLTF = await loadGLB("./characters/deer.glb", "Carregando os cervos da reserva...", 0, 0.12);
    const monsterGLTF = await loadGLB("./characters/the_human_deer.glb", "Algo espreita na escuridão...", 0.12, 0.12);
    const fenceGLTF = await loadGLB("./plantsnshii/fence___door___metal_protection-2part_40mb.glb", "Construindo a cerca de contenção...", 0.24, 0.18);
    const firTreesGLTF = await loadGLB("./plantsnshii/realistic_fir_trees_pack_lods_gameready.glb", "Plantando os pinheiros da floresta...", 0.42, 0.20);
    const oakTreesGLTF = await loadGLB("./plantsnshii/oak_trees.glb", "Modelando os carvalhos...", 0.62, 0.14);
    const treeGLTF = await loadGLB("./plantsnshii/tree.glb", "Adicionando árvores da mata...", 0.76, 0.10);
    const grassGLTF = await loadGLB("./plantsnshii/grass.glb", "Espalhando a vegetação rasteira...", 0.86, 0.08);
    const fernGLTF = await loadGLB("./plantsnshii/fern_grass_01.glb", "Finalizando o ecossistema da reserva...", 0.94, 0.06);

    // Build environment and boundaries
    addFence(fenceGLTF);
    buildEnvironment(firTreesGLTF, oakTreesGLTF, treeGLTF, grassGLTF, fernGLTF);

    deerGLTF.scene.userData.animations = deerGLTF.animations;
    createWorld(deerGLTF.scene, monsterGLTF);

    state.phase = "ready";
    loadingScreen.classList.add("hidden");
    startScreen.classList.remove("hidden");
    frame();
  } catch (error) {
    console.error(error);
    $("#loading-label").textContent = "Não foi possível abrir a floresta.";
    errorMessage.textContent = `${error.message}. Abra o jogo por um servidor local (não diretamente pelo arquivo).`;
    errorMessage.classList.remove("hidden");
  }
}

initialize();
