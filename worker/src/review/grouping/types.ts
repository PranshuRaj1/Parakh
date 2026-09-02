import type { SemanticChange } from '../semantic-diff/entity-parser.js';

export type GroupConfidence = 'high' | 'medium' | 'low';

export interface ChangeGraphNode {
  change: SemanticChange;
  symbol: string | null;
}

export interface ChangeGraphEdge {
  from: string;
  to: string;
  strength: 'strong' | 'weak';
  reason: string;
}

export interface ChangeGraph {
  nodes: ChangeGraphNode[];
  edges: ChangeGraphEdge[];
}

export interface BehaviorGroup {
  id: string;
  anchor: string;
  changes: SemanticChange[];
  context: string[];
  riskSignals: string[];
  confidence: GroupConfidence;
  demotionReason?: string;
}

export interface GroupLineage {
  parentId: string;
  childId: string;
  overlap: string[];
}
