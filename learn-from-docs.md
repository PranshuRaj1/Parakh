# Automating Code Validation

## My Understanding and What I Am Going to Build

This is my understanding of automated code validation and what Greptile aims to achieve.

## Daytime and Nighttime Coding

This explains everything:

![Daytime and nighttime coding](image.png)

Because I want to contribute and make meaningful changes, rather than changes that merely work, I have learned that review is a very important part of the process. I understood this even more while working for an organization.

I write code and then use AI to review it, but it can miss small details, hallucinate, and forget the rules of the codebase.

I remember writing unit tests and getting a suggestion to use cleanup after every test. The AI reviewer was working only from the diff, so it did not look at our global setup, which already cleaned up after test cases.

This was my first experience writing unit tests, doing pull request reviews, and using Greptile.

Since then, I have become really excited about it because it works very well for priority one issues in my pull requests.

I have a plan to build something that I think Greptile might need. Before doing that, I want to understand what they are doing, so I am reading and documenting my understanding of it.

Reaching this point is great, but very difficult:

> “A large, regulated bank should be able to merge a change to flow of funds with only Greptile’s approval. No manual code review, no tests, no QA.”

I have been in tech for around two years, and I strongly believe that AI will create many jobs while removing some. However, I am still deciding how to think about jobs that require accountability. If a feature breaks in production, who do we hold accountable? AI will say sorry and move on.

My opinion may change as I learn more. A quote I love, and one that is mine, is: “The more I learn, the less I know.” Still, I think human oversight will always remain. The pressure to review every line will change and reduce. It is like a class monitor reviewing work before it reaches the subject teacher: it reduces pressure on the teacher, allowing them to focus on their other responsibilities as well.

## What Greptile Does to Validate Code Changes

1. **Deeply understand the product, the business, the codebase, and the intent of the change**

   * Build internal knowledge for every part of the codebase.
   * Store context about the architecture as well.

2. **Understand the blast radius of the change**

   * Changes can be harmless on their own but introduce a new bug two function calls away, in an unchanged part of the codebase.

3. **Read changed files and related files, then evaluate architectural decisions and tradeoffs**

   * Use a knowledge base to eliminate the tens of thousands of tokens an agent would otherwise spend relearning how the codebase works.
   * Use fast open source models for simple but token heavy tasks, such as running searches and following traces, which do not need frontier intelligence.

4. **Run the code and simulate users**

   * Test the application through browser and mobile agents.
   * Simulate production traffic on backend APIs.

5. **Ensure the code is secure through agents and comprehensive security scans**

   Greptile’s approach is hybrid. It lets agents use deterministic scanners to reduce the entropy of the search space. AI then eliminates false positives and detects chained exploits.

6. **Continuously learn from other patches and engineers’ comments**

   * New pull requests create new problems. I learned this myself.
   * Pull requests merged before or while my pull request is being reviewed can also create problems. Generally, teams discuss this on an engineering page or group. I feel our team was not connected to Greptile in this way.

## Models and Cost Efficiency

Initially, what I understood from this talk is that we need a frontier model to do the heavy lifting. Whenever and wherever we can use a smaller context model, a cheaper model, or an open source model, we should use them as much as possible to reduce cost.

It is like having a WeGov solution for each problem, while choosing more efficient WeGov and Log In type solutions whenever possible because they are more efficient and cost saving.

## Why This Matters

Now I really understand why we have data structure and algorithm classes in college, from improving an O(n squared) approach to an O(n log n) approach.

It is interesting that we could have used only frontier models and created two or three agents that discuss with each other to find the exact location of what is wrong. That flow would have been simple, but it would also have been time consuming and expensive, especially in this era where model costs can quickly get out of hand.
