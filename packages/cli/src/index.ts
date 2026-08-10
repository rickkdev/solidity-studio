#!/usr/bin/env node
import { createEmptyGraph } from "@codevis/shared";

export function serviceStatus(): string {
  const graph = createEmptyGraph("Code Visualizer");
  return `${graph.name} local service ready`;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  console.log(serviceStatus());
}
