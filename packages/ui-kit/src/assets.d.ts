// Image imports are resolved by the bundler (Vite) in apps/web.
declare module '*.webp' {
  const src: string;
  export default src;
}
declare module '*.png' {
  const src: string;
  export default src;
}
