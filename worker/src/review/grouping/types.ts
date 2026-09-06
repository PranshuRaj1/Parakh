import type { SemanticChange } from '../semantic-diff/entity-parser.js';
import type { IndexedSymbol } from '@parakh/shared';

export type GroupConfidence = 'high' | 'medium' | 'low';

export interface ChangeGraphNode {
  change: SemanticChange;
  symbol: string | null;
  entity?: IndexedSymbol;
}

export interface ChangeGraphEdge {
  from: string;
  to: string;
  strength: 'strong' | 'weak';
  reason: string;
}

export interface ChangeGraph {
  baseSha?: string;
  nodes: ChangeGraphNode[];
  edges: ChangeGraphEdge[];
  contextNodes?: Array<{ symbol: IndexedSymbol; changeIds: string[]; reason: string }>;
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
