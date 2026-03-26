# About Superteam Ukraine

We're part of Superteam, a global community of Solana builders. We help onboard new talent, run bounties, and support the Solana ecosystem in Ukraine. We're all about fostering growth and innovation in the Web3 space.

# Mission

Build a production-ready, universal Solana indexer that automatically adapts to any Anchor IDL.

**Level:** **Middle**

# Scope Detail

- **Dynamic Schema and Decoding:**
  - Automatically generate a database schema based on the provided IDL, without manual table descriptions.
  - Decode not only instructions but also the program's account states.
- **Indexing Modes:**
  - **Batch Mode:** Process data within a specified slot range or from a list of signatures.
  - **Real-time Mode:** Subscribe to new transactions with a "cold start" capability. When launched, the indexer should first catch up on missed transactions (backfill from the last processed point) and then transition to real-time mode.
- **Reliability:**
  - **Exponential backoff:** Implement increasing delays between RPC retries to avoid overwhelming the node.
  - **Retry mechanism:** For failed requests.
  - **Graceful shutdown:** Ensure correct termination without losing state or incomplete database writes.
- **Advanced API:**
  - Filter by multiple parameters simultaneously.
  - Aggregation, e.g., the number of calls for a specific instruction over a period.
  - Basic program statistics.
- **Infrastructure:**
  - Docker Compose with all dependencies (start with a single command).
  - Configuration via environment variables.
  - Structured logging.

# Submission Requirements

- A public GitHub repository with a comprehensive README, including:
  - Architectural overview.
  - Setup and running instructions.
  - Examples of API queries.
  - Explanation of key architectural decisions and trade-offs.
- A Twitter thread detailing your experience: what you built, how you tackled technical challenges, and the trade-offs you made and why.
- Must be in English.

# Judging Criteria

- Dynamic schema generation and account decoding.
- Real-time mode with cold start functionality.
- Reliability features (exponential backoff, retry mechanisms, graceful shutdown).
- Advanced API capabilities, including aggregation and statistics.
- Code quality, architecture, and presence of tests.
- Clarity and completeness of the README, including explanations of architectural decisions and trade-offs.

# Reward Structure

- 1st Place: 500 USDG
- 2nd Place: 450 USDG
- 3rd Place: 250 USDG
