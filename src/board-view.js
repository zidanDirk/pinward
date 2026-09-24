import * as THREE from "three";
import { WIDTH, HEIGHT, CELL } from "./physics.js";

export const boardPoint = (x, y, elevation = 0) =>
  new THREE.Vector3(x - WIDTH / 2, elevation, y - HEIGHT / 2);

export function createBoardCamera() {
  const camera = new THREE.OrthographicCamera(-500, 500, 500, -500, 1, 4000);
  return camera;
}

export function fitBoardCamera(camera, aspect, mode = "3d") {
  camera.position.set(...(mode === "top" ? [0, 1600, 0.01] : [270, 1400, 800]));
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const bounds = new THREE.Box3();
  for (const x of [-320, 320])
    for (const z of [-490, 490]) {
      bounds.expandByPoint(
        new THREE.Vector3(x, -40, z).applyMatrix4(camera.matrixWorldInverse),
      );
      bounds.expandByPoint(
        new THREE.Vector3(x, 90, z).applyMatrix4(camera.matrixWorldInverse),
      );
    }
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const height = Math.max(size.y, size.x / aspect) * 1.08;
  camera.left = center.x - (height * aspect) / 2;
  camera.right = center.x + (height * aspect) / 2;
  camera.top = center.y + height / 2;
  camera.bottom = center.y - height / 2;
  camera.updateProjectionMatrix();
}

const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const raycaster = new THREE.Raycaster();
const hit = new THREE.Vector3();
export function pickBoard(camera, rect, clientX, clientY) {
  if (!rect.width || !rect.height) return null;
  const pointer = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    (-(clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(pointer, camera);
  if (!raycaster.ray.intersectPlane(plane, hit)) return null;
  const x = hit.x + WIDTH / 2,
    y = hit.z + HEIGHT / 2;
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return null;
  return { col: Math.floor(x / CELL), row: Math.floor(y / CELL) };
}

export function projectBoard(camera, rect, x, y, elevation = 0) {
  const point = boardPoint(x, y, elevation).project(camera);
  return {
    x: rect.left + ((point.x + 1) / 2) * rect.width,
    y: rect.top + ((1 - point.y) / 2) * rect.height,
  };
}
