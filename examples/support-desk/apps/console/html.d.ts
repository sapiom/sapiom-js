/** esbuild's `text` loader inlines the page into the bundle (`console:build`). */
declare module "*.html" {
  const text: string;
  export default text;
}
