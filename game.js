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
scene.background = new THREE.Color(0x030605);
scene.fog = new THREE.FogExp2(0x050907, 0.022);

const camera = new THREE.PerspectiveCamera(78, innerWidth / innerHeight, 0.08, 180);
const renderer = new THREE.WebGLRenderer({ canvas: sceneCanvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.18;

scene.add(new THREE.HemisphereLight(0x78918a, 0x080c09, 0.24));
const moonlight = new THREE.DirectionalLight(0xb7c9d0, 0.32);
moonlight.position.set(-38, 64, -48);
moonlight.castShadow = true;
moonlight.shadow.mapSize.set(2048, 2048);
moonlight.shadow.camera.left = -80;
moonlight.shadow.camera.right = 80;
moonlight.shadow.camera.top = 90;
moonlight.shadow.camera.bottom = -90;
moonlight.shadow.bias = -0.0004;
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
const worldLimit = { x: 45, minZ: -111, maxZ: 86 };
const exitPosition = new THREE.Vector3(0, 0, -104);
const state = {
  phase: "loading",
  elapsed: 0,
  stamina: 100,
  hunterAwake: false,
  hunterPosition: new THREE.Vector3(),
  hunter: null,
  hunterMixer: null,
  hunterAction: null,
  playerArms: [],
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

function makeMaterial(color, roughness = 1) {
  return new THREE.MeshStandardMaterial({ color, roughness, flatShading: true });
}

function addGround() {
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(240, 280, 1, 1),
    makeMaterial(0x141a12),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, -0.1, -8);
  ground.receiveShadow = true;
  scene.add(ground);

  const grassVariants = [[], []];
  for (let index = 0; index < 280; index += 1) {
    const x = (random() - 0.5) * 225;
    const z = (random() - 0.5) * 255 - 8;
    const variant = random() > 0.5 ? 1 : 0;
    instanceHelper.position.set(x, 0.08, z);
    instanceHelper.scale.set(
      0.06 + random() * 0.09,
      0.25 + random() * 0.35,
      0.06 + random() * 0.09,
    );
    instanceHelper.rotation.set(0, random() * Math.PI, (random() - 0.5) * 0.45);
    instanceHelper.updateMatrix();
    grassVariants[variant].push(instanceHelper.matrix.clone());
  }
  for (const [index, matrices] of grassVariants.entries()) {
    const grass = new THREE.InstancedMesh(
      new THREE.ConeGeometry(1, 1, 3),
      makeMaterial(index === 0 ? 0x738064 : 0x959075),
      matrices.length,
    );
    matrices.forEach((matrix, instanceIndex) => grass.setMatrixAt(instanceIndex, matrix));
    grass.instanceMatrix.needsUpdate = true;
    scene.add(grass);
  }
}

const treeMaterials = [
  makeMaterial(0x354735),
  makeMaterial(0x40523b),
  makeMaterial(0x2d3e35),
];
const trunkMaterial = makeMaterial(0x403b30);
const treeTrunkInstances = [];
const treeInstances = Array.from({ length: 4 }, () =>
  Array.from({ length: treeMaterials.length }, () => []),
);
const treeFoliageGeometry = new THREE.ConeGeometry(1, 1, 7);
const treeTrunkGeometry = new THREE.CylinderGeometry(0.22, 0.42, 4, 7);
const instanceHelper = new THREE.Object3D();

function addTree(x, z, scale = 1) {
  const treeScale = 0.78 + random() * 0.42;
  instanceHelper.position.set(x, 2 * scale, z);
  instanceHelper.rotation.set(0, 0, 0);
  instanceHelper.scale.setScalar(scale);
  instanceHelper.updateMatrix();
  treeTrunkInstances.push(instanceHelper.matrix.clone());

  for (let layer = 0; layer < 4; layer += 1) {
    const radius = (2.35 - layer * 0.43) * treeScale;
    const materialIndex = Math.floor(random() * treeMaterials.length);
    instanceHelper.position.set(x, (3.5 + layer * 1.65) * scale, z);
    instanceHelper.rotation.set(0, random() * Math.PI, 0);
    instanceHelper.scale.set(radius * scale, 1.7 * scale, radius * scale);
    instanceHelper.updateMatrix();
    treeInstances[layer][materialIndex].push(instanceHelper.matrix.clone());
  }
  if (Math.abs(x) < 45 && z < 86 && z > -111) {
    obstacles.push({ x, z, radius: 1.2 * scale });
  }
}

function addForestInstances() {
  const trunks = new THREE.InstancedMesh(treeTrunkGeometry, trunkMaterial, treeTrunkInstances.length);
  treeTrunkInstances.forEach((matrix, index) => trunks.setMatrixAt(index, matrix));
  trunks.instanceMatrix.needsUpdate = true;
  trunks.castShadow = true;
  trunks.receiveShadow = true;
  scene.add(trunks);

  for (let layer = 0; layer < treeInstances.length; layer += 1) {
    for (let materialIndex = 0; materialIndex < treeMaterials.length; materialIndex += 1) {
      const matrices = treeInstances[layer][materialIndex];
      if (!matrices.length) continue;
      const foliage = new THREE.InstancedMesh(
        treeFoliageGeometry,
        treeMaterials[materialIndex],
        matrices.length,
      );
      matrices.forEach((matrix, index) => foliage.setMatrixAt(index, matrix));
      foliage.instanceMatrix.needsUpdate = true;
      foliage.castShadow = true;
      foliage.receiveShadow = true;
      scene.add(foliage);
    }
  }
}

function addForest() {
  addGround();
  for (let index = 0; index < 260; index += 1) {
    let x = (random() - 0.5) * 150;
    const z = (random() - 0.5) * 225 - 6;
    if (Math.hypot(x - exitPosition.x, z - exitPosition.z) < 12) continue;
    addTree(x, z, 0.72 + random() * 1.15);
  }
  addForestInstances();

  const rockMaterial = makeMaterial(0x596052);
  const rockMatrices = [];
  for (let index = 0; index < 56; index += 1) {
    const side = random() > 0.5 ? 1 : -1;
    const x = side * (6.6 + random() * 26);
    const z = 66 - random() * 160;
    const scale = 0.45 + random() * 0.9;
    instanceHelper.position.set(x, 0.38, z);
    instanceHelper.scale.set(1.35 * scale, 0.85 * scale, scale);
    instanceHelper.rotation.set(random(), random(), random());
    instanceHelper.updateMatrix();
    rockMatrices.push(instanceHelper.matrix.clone());
    if (Math.abs(x) < 45 && z < 86 && z > -111) obstacles.push({ x, z, radius: 1 });
  }
  const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), rockMaterial, rockMatrices.length);
  rockMatrices.forEach((matrix, index) => rocks.setMatrixAt(index, matrix));
  rocks.instanceMatrix.needsUpdate = true;
  rocks.castShadow = true;
  rocks.receiveShadow = true;
  scene.add(rocks);
}

function addExit() {
  const gate = new THREE.Group();
  gate.position.copy(exitPosition);
  const wood = makeMaterial(0x89724e);
  const postGeometry = new THREE.CylinderGeometry(0.17, 0.23, 5.2, 7);
  for (const x of [-3.6, 3.6]) {
    const post = new THREE.Mesh(postGeometry, wood);
    post.position.set(x, 2.6, 0);
    post.castShadow = true;
    gate.add(post);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(8, 0.35, 0.42), wood);
  beam.position.y = 5.05;
  beam.castShadow = true;
  gate.add(beam);

  const glow = new THREE.Mesh(
    new THREE.BoxGeometry(7.7, 0.1, 0.06),
    new THREE.MeshBasicMaterial({ color: 0xd9e8ac, transparent: true, opacity: 0.9 }),
  );
  glow.position.set(0, 5.28, 0);
  gate.add(glow);

  const lampMaterial = new THREE.MeshBasicMaterial({ color: 0xc9da92 });
  for (const x of [-3.6, 3.6]) {
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 8), lampMaterial);
    lamp.position.set(x, 4.4, 0);
    gate.add(lamp);
    const point = new THREE.PointLight(0xd6e8ae, 1.8, 8, 2);
    point.position.copy(lamp.position);
    gate.add(point);
  }
  const sign = new THREE.Mesh(
    new THREE.BoxGeometry(2.4, 0.52, 0.16),
    makeMaterial(0x364532),
  );
  sign.position.set(0, 4.32, 0.28);
  gate.add(sign);
  scene.add(gate);
  state.exit = gate;
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
        node.material.side = THREE.DoubleSide;
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
  const container = makeCharacterContainer(copy, 2.2, position, Math.PI);
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
  deer.push({
    container,
    origin: position.clone(),
    phase: random() * Math.PI * 2,
    idleAction,
    walkAction,
    walking: false,
    nextMoveAt: random() * 5 + 2,
  });
  return container;
}

function addFirstPersonView(soldierModel) {
  const sleeveColor = new THREE.Color(0x303b2e);
  const shirt = soldierModel.getObjectByName("Clotch_up_Clotch_up_0");
  if (shirt?.isMesh && shirt.material) {
    const material = Array.isArray(shirt.material) ? shirt.material[0] : shirt.material;
    if (material.color) {
      sleeveColor.copy(material.color).multiplyScalar(0.38).lerp(new THREE.Color(0x293526), 0.45);
    }
  }
  const sleeveMaterial = new THREE.MeshStandardMaterial({ color: sleeveColor, roughness: 0.9 });
  const gloveMaterial = new THREE.MeshStandardMaterial({ color: 0x252821, roughness: 0.95 });
  const armGeometry = new THREE.CapsuleGeometry(0.065, 0.36, 4, 8);
  const handGeometry = new THREE.SphereGeometry(0.065, 10, 8);
  for (const side of [-1, 1]) {
    const arm = new THREE.Group();
    arm.position.set(side * 0.23, -0.58, -0.68);
    const sleeve = new THREE.Mesh(armGeometry, sleeveMaterial);
    sleeve.rotation.z = side * 0.48;
    sleeve.position.set(-side * 0.045, -0.025, 0);
    const glove = new THREE.Mesh(handGeometry, gloveMaterial);
    glove.position.set(-side * 0.095, -0.2, -0.025);
    arm.add(sleeve, glove);
    camera.add(arm);
    state.playerArms.push(arm);
  }

  const flashlightBody = new THREE.Mesh(
    new THREE.CylinderGeometry(0.045, 0.06, 0.32, 12),
    new THREE.MeshStandardMaterial({ color: 0x222720, metalness: 0.35, roughness: 0.55 }),
  );
  flashlightBody.rotation.x = Math.PI / 2;
  flashlightBody.position.set(0.3, -0.55, -0.63);
  camera.add(flashlightBody);
  const lens = new THREE.Mesh(
    new THREE.CircleGeometry(0.043, 16),
    new THREE.MeshBasicMaterial({ color: 0xffe6b2 }),
  );
  lens.position.set(0.3, -0.55, -0.8);
  camera.add(lens);

  const target = new THREE.Object3D();
  target.position.set(0, -0.72, -24);
  camera.add(target);
  const flashlight = new THREE.SpotLight(0xffe3b2, 360, 32, Math.PI / 6, 0.62, 1.15);
  flashlight.position.set(0.16, -0.12, -0.22);
  flashlight.target = target;
  flashlight.castShadow = true;
  flashlight.shadow.mapSize.set(1024, 1024);
  flashlight.shadow.camera.near = 0.1;
  flashlight.shadow.camera.far = 30;
  flashlight.shadow.bias = -0.00015;
  camera.add(flashlight);
  state.flashlight = flashlight;
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

function randomForestPoint({
  playerDistance = 0,
  exitDistance = 0,
  existing = [],
  existingDistance = 0,
} = {}) {
  for (let attempt = 0; attempt < 800; attempt += 1) {
    const point = new THREE.Vector3(-39 + Math.random() * 78, 0, -96 + Math.random() * 178);
    if (point.distanceTo(exitPosition) < exitDistance) continue;
    if (point.distanceTo(playerPosition) < playerDistance) continue;
    if (existing.some((other) => point.distanceTo(other) < existingDistance)) continue;
    if (hitsObstacle(point.x, point.z)) continue;
    if (obstacles.some((obstacle) => {
      const dx = point.x - obstacle.x;
      const dz = point.z - obstacle.z;
      const canopyClearance = obstacle.radius + 3.5;
      return dx * dx + dz * dz < canopyClearance * canopyClearance;
    })) continue;
    return point;
  }
  throw new Error("Não foi possível encontrar um espaço livre para iniciar na floresta.");
}

function createWorld(deerModel, monsterGLTF, soldierGLTF) {
  const start = randomForestPoint({ exitDistance: 52 });
  playerPosition.copy(start);
  addFirstPersonView(soldierGLTF.scene);

  const positions = [];
  for (let index = 0; index < 30; index += 1) {
    positions.push(randomForestPoint({
      playerDistance: 12,
      exitDistance: 16,
      existing: positions,
      existingDistance: 6,
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
  state.hunter = makeCharacterContainer(monsterModel, 3.15, positions[disguisedIndex], Math.PI);
  state.hunter.visible = false;
  if (monsterGLTF.animations.length) {
    state.hunterMixer = new THREE.AnimationMixer(monsterModel);
    state.hunterAction = state.hunterMixer.clipAction(monsterGLTF.animations[0]);
    mixers.push(state.hunterMixer);
    state.hunterAction.play();
  }
}

function startAudio() {
  if (state.audioStarted) return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  const context = new AudioContext();
  const master = context.createGain();
  master.gain.value = 0.13;
  master.connect(context.destination);
  const low = context.createOscillator();
  const lowGain = context.createGain();
  low.type = "sine";
  low.frequency.value = 48;
  lowGain.gain.value = 0.24;
  low.connect(lowGain);
  lowGain.connect(master);
  low.start();
  const wind = context.createOscillator();
  const windGain = context.createGain();
  const filter = context.createBiquadFilter();
  wind.type = "sawtooth";
  wind.frequency.value = 91;
  filter.type = "lowpass";
  filter.frequency.value = 220;
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
    exitDistance: 52,
    existing: deer.map((animal) => animal.origin),
    existingDistance: 14,
  }));
  state.cameraPitch = 0;
  state.hunter.visible = false;
  deer.forEach((animal) => {
    const { container, origin, idleAction, walkAction } = animal;
    container.visible = true;
    container.position.copy(origin);
    if (walkAction) walkAction.stop();
    if (idleAction) {
      idleAction.reset();
      idleAction.play();
    }
  });
  state.hunterPosition.copy(state.disguisedDeer.container.position);
  state.hunter.position.copy(state.hunterPosition);
  if (state.hunterMixer && state.hunterAction) {
    state.hunterMixer.stopAllAction();
    state.hunterAction.reset().play();
  }
  startScreen.classList.add("hidden");
  endScreen.classList.add("hidden");
  $("#pause-indicator").classList.add("hidden");
  hud.classList.remove("hidden");
  $("#crosshair").classList.remove("hidden");
  $("#threat-card").classList.remove("alert");
  $("#threat-text").textContent = "A floresta está quieta demais.";
  $("#warning-banner").classList.remove("visible");
  $("#objective-text").textContent = "Encontre a saída da floresta";
  $("#exit-marker").classList.add("hidden");
  $("#stamina-caption").textContent = "Guarde energia. Você vai precisar.";
  deer.forEach((animal) => {
    animal.walking = false;
    animal.target = null;
    animal.nextMoveAt = 1 + Math.random() * 3;
  });
  if (state.sound) {
    const now = state.sound.context.currentTime;
    state.sound.lowGain.gain.setTargetAtTime(0.24, now, 0.3);
    state.sound.master.gain.setTargetAtTime(0.13, now, 0.3);
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
    $("#end-eyebrow").textContent = "VOCÊ ENCONTROU O CAMINHO DE VOLTA";
    $("#end-title").innerHTML = "VOCÊ<br /><span>CONSEGUIU.</span>";
    $("#end-message").textContent = "A mata ficou para trás. Mas algo ainda observa da escuridão.";
  } else {
    endScreen.classList.add("lost");
    $("#end-eyebrow").textContent = "A FLORESTA GUARDA SEGREDOS";
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
    $("#threat-text").textContent = hunterDistance < 14 ? "Está logo atrás de você. CORRA." : "Ele está vindo. Não olhe para trás.";
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
  $("#threat-card").classList.add("alert");
  $("#threat-text").textContent = "Ele percebeu você.";
  $("#objective-text").textContent = "CORRA até a saída da floresta";
  $("#warning-banner").classList.add("visible");
  $("#exit-marker").classList.remove("hidden");
  $("#stamina-caption").textContent = "Segure SHIFT para correr mais rápido.";
  window.setTimeout(() => $("#warning-banner").classList.remove("visible"), 2600);

  state.tremble = 2.5;
  state.huntDelay = 1.7;
  if (state.sound) {
    const now = state.sound.context.currentTime;
    state.sound.lowGain.gain.cancelScheduledValues(now);
    state.sound.lowGain.gain.setTargetAtTime(0.8, now, 0.18);
    state.sound.master.gain.setTargetAtTime(0.28, now, 0.25);
    const alarm = state.sound.context.createOscillator();
    const gain = state.sound.context.createGain();
    alarm.type = "sawtooth";
    alarm.frequency.setValueAtTime(138, now);
    alarm.frequency.exponentialRampToValueAtTime(74, now + 1.4);
    gain.gain.setValueAtTime(0.17, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 1.5);
    alarm.connect(gain);
    gain.connect(state.sound.master);
    alarm.start(now);
    alarm.stop(now + 1.55);
  }
}

function hitsObstacle(x, z) {
  return obstacles.some((obstacle) => {
    const dx = x - obstacle.x;
    const dz = z - obstacle.z;
    const threshold = obstacle.radius + 0.72;
    return dx * dx + dz * dz < threshold * threshold;
  });
}

function chooseDeerTarget(animal) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const angle = Math.random() * Math.PI * 2;
    const distance = 7 + Math.random() * 12;
    const target = new THREE.Vector3(
      THREE.MathUtils.clamp(animal.container.position.x + Math.cos(angle) * distance, -worldLimit.x, worldLimit.x),
      0,
      THREE.MathUtils.clamp(animal.container.position.z + Math.sin(angle) * distance, worldLimit.minZ, worldLimit.maxZ),
    );
    if (hitsObstacle(target.x, target.z)) continue;
    const crowded = deer.some((other) =>
      other !== animal && other.container.visible && other.container.position.distanceTo(target) < 3.8,
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

function setDeerGait(animal, walking) {
  animal.walking = walking;
  if (walking) {
    animal.idleAction?.fadeOut(0.3);
    if (animal.walkAction) {
      animal.walkAction.reset().fadeIn(0.3).play();
      animal.walkAction.setEffectiveTimeScale(1.15);
    }
  } else {
    animal.walkAction?.fadeOut(0.3);
    if (animal.idleAction) animal.idleAction.reset().fadeIn(0.3).play();
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
  const speed = sprinting ? 7.25 : 4.25;
  if (sprinting) state.stamina = Math.max(0, state.stamina - delta * 20);
  else state.stamina = Math.min(100, state.stamina + delta * (inputLength ? 13 : 20));

  const forwardX = -Math.sin(state.cameraYaw);
  const forwardZ = -Math.cos(state.cameraYaw);
  const rightX = Math.cos(state.cameraYaw);
  const rightZ = -Math.sin(state.cameraYaw);
  const dx = (forwardX * forwardInput + rightX * sideInput) * speed * delta;
  const dz = (forwardZ * forwardInput + rightZ * sideInput) * speed * delta;
  const nextX = THREE.MathUtils.clamp(playerPosition.x + dx, -worldLimit.x, worldLimit.x);
  const nextZ = THREE.MathUtils.clamp(playerPosition.z + dz, worldLimit.minZ, worldLimit.maxZ);
  if (!hitsObstacle(nextX, playerPosition.z)) playerPosition.x = nextX;
  if (!hitsObstacle(playerPosition.x, nextZ)) playerPosition.z = nextZ;
  state.playerMoving = inputLength > 0;
  const stepSpeed = sprinting ? 13 : 8;
  if (state.playerMoving) state.playerStep += delta * stepSpeed;
  else state.playerStep = THREE.MathUtils.damp(state.playerStep, 0, 6, delta);
  const armSwing = state.playerMoving ? Math.sin(state.playerStep) * (sprinting ? 0.28 : 0.17) : 0;
  state.playerArms[0].rotation.z = armSwing;
  state.playerArms[1].rotation.z = -armSwing;
}

function updateHunter(delta) {
  if (!state.hunterAwake) {
    if (playerPosition.distanceTo(state.disguisedDeer.container.position) < 7.2) awakenHunter();
    return;
  }

  if (state.huntDelay > 0) {
    state.huntDelay = Math.max(0, state.huntDelay - delta);
    return;
  }

  tempVector.subVectors(playerPosition, state.hunterPosition);
  const distance = tempVector.length();
  state.threatDistance = distance;
  if (distance > 0.01) {
    tempVector.normalize();
    const pace = distance > 14 ? 5.9 : 6.05;
    state.hunterPosition.addScaledVector(tempVector, Math.min(distance - 1.65, pace * delta));
    state.hunter.position.copy(state.hunterPosition);
    state.hunter.rotation.y = Math.atan2(-tempVector.x, -tempVector.z);
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
  for (const animal of deer) {
    if (animal.container.visible) {
      if (state.elapsed >= animal.nextMoveAt) {
        if (animal.walking) {
          setDeerGait(animal, false);
          animal.target = null;
          animal.nextMoveAt = state.elapsed + 1.5 + Math.random() * 3.5;
        } else {
          animal.target = chooseDeerTarget(animal);
          if (animal.target) {
            setDeerGait(animal, true);
            animal.nextMoveAt = state.elapsed + 30;
          } else {
            animal.nextMoveAt = state.elapsed + 1 + Math.random() * 2;
          }
        }
      }
      if (animal.walking && animal.target) {
        tempVector.subVectors(animal.target, animal.container.position);
        const distance = tempVector.length();
        if (distance < 0.35) {
          setDeerGait(animal, false);
          animal.target = null;
          animal.nextMoveAt = state.elapsed + 1.5 + Math.random() * 3.5;
        } else {
          tempVector.normalize();
          const speed = 1.65 + Math.sin(animal.phase + state.elapsed * 0.8) * 0.12;
          const travel = Math.min(distance, speed * delta);
          const nextX = animal.container.position.x + tempVector.x * travel;
          const nextZ = animal.container.position.z + tempVector.z * travel;
          if (hitsObstacle(nextX, nextZ)) {
            setDeerGait(animal, false);
            animal.target = null;
            animal.nextMoveAt = state.elapsed + 0.5 + Math.random();
          } else {
            animal.container.position.x = nextX;
            animal.container.position.z = nextZ;
            animal.container.rotation.y = Math.atan2(tempVector.x, tempVector.z);
          }
        }
      } else {
        animal.container.rotation.y = Math.sin(state.elapsed * 0.7 + animal.phase) * 0.12;
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
    if (playerPosition.distanceTo(exitPosition) < 6.2) endGame(true);
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
  addForest();
  addExit();
  showLoadProgress("Carregando o cervo da floresta...", 0);

  try {
    const deerGLTF = await loadGLB("./characters/deer.glb", "Carregando o cervo da floresta...", 0, 0.34);
    const monsterGLTF = await loadGLB("./characters/the_human_deer.glb", "Algo está se mexendo entre as árvores...", 0.34, 0.34);
    const soldierGLTF = await loadGLB("./characters/soldier_human.glb", "Preparando quem vai sobreviver...", 0.68, 0.32);
    deerGLTF.scene.userData.animations = deerGLTF.animations;
    createWorld(deerGLTF.scene, monsterGLTF, soldierGLTF);
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
