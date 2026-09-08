declare module "solc-0.7" { const compiler: { compile: (source: string) => string; version: () => string }; export default compiler; }
