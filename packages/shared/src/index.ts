export interface GraphSummary {
  readonly name: string;
  readonly nodeCount: number;
}

export function createEmptyGraph(name: string): GraphSummary {
  return { name, nodeCount: 0 };
}
