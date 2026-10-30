// The shared package calls structuredClone in mergeSettings. React Native's type definitions do not declare it and the
// app never calls that function, so this only lets the shared sources type-check.
declare function structuredClone<T>(value: T): T;
