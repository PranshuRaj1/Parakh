import Link from 'next/link';
import { BrainCircuit, GitPullRequest, ArrowRight } from 'lucide-react';

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[70vh] text-center px-4 animate-in fade-in zoom-in-95 duration-500">
      <div className="bg-indigo-100 dark:bg-indigo-900/30 p-4 rounded-full mb-8">
        <BrainCircuit className="w-16 h-16 text-indigo-600 dark:text-indigo-400" />
      </div>
      <h1 className="text-5xl font-extrabold tracking-tight text-gray-900 dark:text-white mb-6">
        Welcome to Parakh
      </h1>
      <p className="text-xl text-gray-500 dark:text-gray-400 max-w-2xl mb-10 leading-relaxed">
        The AI Code Review Bot that learns your team's coding standards from PR comments, tracks them in a versioned memory, and automatically detects contradictions.
      </p>
      
      <div className="flex flex-col sm:flex-row gap-4">
        <Link 
          href="/memory" 
          className="inline-flex items-center justify-center px-6 py-3 border border-transparent text-base font-medium rounded-lg text-white bg-indigo-600 hover:bg-indigo-700 shadow-sm transition-colors"
        >
          <BrainCircuit className="w-5 h-5 mr-2" />
          View Repository Memory
        </Link>
        <Link 
          href="/pulls" 
          className="inline-flex items-center justify-center px-6 py-3 border border-gray-300 dark:border-zinc-700 text-base font-medium rounded-lg text-gray-700 dark:text-gray-200 bg-white dark:bg-zinc-900 hover:bg-gray-50 dark:hover:bg-zinc-800 shadow-sm transition-colors"
        >
          <GitPullRequest className="w-5 h-5 mr-2" />
          View Recent Pulls
        </Link>
      </div>

      <div className="mt-20 grid grid-cols-1 sm:grid-cols-3 gap-8 text-left max-w-4xl w-full">
        <div className="p-6 bg-white dark:bg-zinc-950 rounded-xl border border-gray-100 dark:border-zinc-800 shadow-sm">
          <h3 className="font-bold text-lg mb-2 text-gray-900 dark:text-white">Deterministic Scoring</h3>
          <p className="text-gray-500 dark:text-gray-400 text-sm leading-relaxed">
            Severity for rule violations is computed in code, not guessed by the LLM. 100% predictable scoring.
          </p>
        </div>
        <div className="p-6 bg-white dark:bg-zinc-950 rounded-xl border border-gray-100 dark:border-zinc-800 shadow-sm">
          <h3 className="font-bold text-lg mb-2 text-gray-900 dark:text-white">Contradiction Engine</h3>
          <p className="text-gray-500 dark:text-gray-400 text-sm leading-relaxed">
            Vector embeddings detect when a new rule contradicts an old one, automatically superseding it.
          </p>
        </div>
        <div className="p-6 bg-white dark:bg-zinc-950 rounded-xl border border-gray-100 dark:border-zinc-800 shadow-sm">
          <h3 className="font-bold text-lg mb-2 text-gray-900 dark:text-white">Learn on Camera</h3>
          <p className="text-gray-500 dark:text-gray-400 text-sm leading-relaxed">
            Reply to the bot with a correction on any PR, and it instantly learns the rule and applies it to the next review.
          </p>
        </div>
      </div>
    </div>
  );
}
