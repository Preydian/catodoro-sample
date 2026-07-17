// Sample-repo stub. In the full app (src/components/physics/colliders.ts)
// this reads live physics-engine state: true while a pointer is carrying a
// cat, which outranks the camera - useCanvas holds the pan still and
// re-baselines so the camera resumes without a jump when the cat is dropped.
// The physics scene itself (three.js + Rapier) is not part of this sample.
const isDraggingCat = (): boolean => false;

export { isDraggingCat };
