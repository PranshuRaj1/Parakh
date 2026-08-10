import Link from 'next/link';
import { BrainCircuit, GitPullRequest } from 'lucide-react';

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[70vh] text-center px-4 animate-in fade-in zoom-in-95 duration-500">
      <div className="bg-[rgba(197,255,214,0.1)] p-4 rounded-full mb-8 border border-[rgba(197,255,214,0.2)]">
        <BrainCircuit className="w-16 h-16 text-[var(--primary-color)]" />
      </div>
      <h1 className="text-5xl font-extrabold tracking-tight text-white mb-6" style={{ letterSpacing: '-0.04em' }}>
        Welcome to Parakh
      </h1>
      <p className="text-xl text-gray-400 max-w-2xl mb-10 leading-relaxed">
        The AI Code Review Bot that learns your team's coding standards from PR comments, tracks them in a versioned memory, and automatically detects contradictions.
      </p>
      
      <div className="flex flex-col sm:flex-row gap-4">
        <Link 
          href="/memory" 
          className="btn btn-primary text-base px-6 py-3"
        >
          <BrainCircuit className="w-5 h-5 mr-2" />
          View Repository Memory
        </Link>
        <Link 
          href="/pulls" 
          className="btn btn-secondary text-base px-6 py-3"
        >
          <GitPullRequest className="w-5 h-5 mr-2" />
          View Recent Pulls
        </Link>
      </div>

      <div className="mt-20 grid grid-cols-1 sm:grid-cols-3 gap-8 text-left max-w-5xl w-full">
        <div className="glass-card">
          <h3 className="font-bold text-lg mb-2 text-white">Deterministic Scoring</h3>
          <p className="text-gray-400 text-sm leading-relaxed">
            Severity for rule violations is computed in code, not guessed by the LLM. <span className="technical-data text-[var(--primary-color)]">100% predictable</span> scoring.
          </p>
        </div>
        <div className="glass-card">
          <h3 className="font-bold text-lg mb-2 text-white">Contradiction Engine</h3>
          <p className="text-gray-400 text-sm leading-relaxed">
            Vector embeddings detect when a new rule contradicts an old one, automatically superseding it.
          </p>
        </div>
        <div className="glass-card">
          <h3 className="font-bold text-lg mb-2 text-white">Learn on Camera</h3>
          <p className="text-gray-400 text-sm leading-relaxed">
            Reply to the bot with a correction on any PR, and it instantly learns the rule and applies it to the next review.
          </p>
        </div>
      </div>
    </div>
  );
}
