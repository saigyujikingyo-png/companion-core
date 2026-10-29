import { runTrustedStdio } from '../../src/coupled-stdio.ts';

// Offline process fixture only: no network, credential discovery or native host.
const delayedB = process.argv[2] === '--delay-b-2300';
void runTrustedStdio({
  input: process.stdin,
  output: process.stdout,
  providerFactory: (_config, resources) => ({
    interact: async (input) => {
      resources.budget.reserve(input.requestId);
      // Legal asynchronous work below the unchanged production lease/deadline. The
      // functional parent must not impose the former two-second performance claim.
      if (delayedB && input.requestId === 'B') await new Promise<void>((resolve) => setTimeout(resolve, 2300));
      return {
        version: 1,
        responseText: 'SYNTHETIC_OFFLINE_REPLY',
        memoryProposal: null,
        appraisal: {
          kind: 'appraisal-hypothesis',
          confidence: 0.8,
          valence: 0.4,
          arousal: 0.2,
          uncertainty: 0,
          fatigue: 0,
        },
      };
    },
  }),
}).then(
  (result) => process.exit(result.status === 'closed' ? 0 : 1),
  () => process.exit(2),
);
