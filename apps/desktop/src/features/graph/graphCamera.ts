export interface GraphCameraPoint {
    x: number;
    y: number;
    z: number;
}

const DEFAULT_CAMERA_DIRECTION: GraphCameraPoint = { x: 0, y: 0, z: 1 };

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

export function getGraphFocusDistance(
    currentDistance: number | null,
    importance: number,
): number {
    const importanceDistance = 78 + Math.sqrt(Math.max(1, importance)) * 20;
    const contextualDistance =
        typeof currentDistance === "number" && Number.isFinite(currentDistance)
            ? currentDistance * 0.32
            : importanceDistance;

    return clamp(Math.max(importanceDistance, contextualDistance), 88, 220);
}

export function getFocusedCameraPosition(
    node: GraphCameraPoint,
    camera: GraphCameraPoint | null,
    distance: number,
): GraphCameraPoint {
    const dx = (camera?.x ?? 0) - node.x;
    const dy = (camera?.y ?? 0) - node.y;
    const dz = (camera?.z ?? 0) - node.z;
    const magnitude = Math.hypot(dx, dy, dz);

    const direction =
        magnitude > 0.0001
            ? {
                  x: dx / magnitude,
                  y: dy / magnitude,
                  z: dz / magnitude,
              }
            : DEFAULT_CAMERA_DIRECTION;

    return {
        x: node.x + direction.x * distance,
        y: node.y + direction.y * distance,
        z: node.z + direction.z * distance,
    };
}
