# Bounded synthetic BM25 comparison

Research-only baseline. The independently reviewed, fixed 16-query comparison was completed once on 2026-10-28; [public synthetic results](results-fixed16.json) retain all original queries, gold labels, outputs and negative cases. No production retrieval integration, new authority, persistence, model, embedding, PPR, learning or Spark execution. This does not complete AR1.

`rankBm25(statements, query, limit=8)` accepts selected strings only and returns immutable `{ordinal, score}` entries. Normalize with NFKC then default lowercase; terms are contiguous Unicode letters/numbers (`/[\p{L}\p{N}]+/gu`), matching AR0 term boundaries. Document TF is retained, query terms deduplicated; no stemming, stopwords, ngrams, language segmentation or tuning. With `k1=1.2`, `b=.75`, `idf=ln(1+(N-df+.5)/(df+.5))`, each matching term contributes `idf*tf*(k1+1)/(tf+k1*(1-b+b*dl/avgdl))`. N and average length include empty documents. All-empty or zero-term cases return no hits; only positive scores are returned, descending with ordinal ties. Defaults and IDF reference: [Lucene 9.12.3 BM25Similarity](https://lucene.apache.org/core/9_12_3/core/org/apache/lucene/search/similarities/BM25Similarity.html). This is the specified formula, not a claim of Lucene analyzer/norm-byte compatibility.

The original 32 selected / 128 source nodes / 512 edges / 262144 serialized-byte gates remain. Query uses the actual AR0 scalar validator: nonempty, no NUL, at most 256 **UTF-16 code units**, and not normalized whitespace; limit is 1–32. Each selected statement is at most Store's 4096 code units (empty strings are supported by the pure function). Before full normalization/TF allocation, bounded scalar NFKD/lowercase expansion reserves a conservative JSON representation cost: 4352 fixed bytes plus 28 per decomposed/lowercased code unit for normalized strings, token keys and TF entries. This can reject inputs whose actual compact representation would fit. The driver adds both retained snapshot copies to that reservation before ranking; overflow rejects the whole comparison. These are serialized-byte bounds, not RSS estimates. Store source-closure accounting and existing AR0 projection accounting remain independent checks.

The schema2 fixture uses public Store APIs and genuine consumer snapshots. It assigns fixed fixture publication ordinals to the complete current pool and uses that same refs order with the original AR0 bind/refresh/query/resolve. This fixes synthetic tie order without changing production consumer UUID sorting. Before mapping the BM25 result, the driver reads the complete consumer snapshot again, rejects backward time, and compares complete authority, selected content and consumer receipt (only consumer `readAsOf` is excluded). Empty results follow the same check. Ordinals never become AR0 candidates or source permissions.

`cohort.ts` freezes eight families with two queries each: frequency/length/ties; rare identifiers and hyphens; entirely unknown; shared topics with missing identifiers; same-object contradictions; shared-root supplements/duplicates; fullwidth/case and Chinese contiguous-substring limits; punctuation/emoji literals. No random sampling. Gold relevant ordinals, supported/unknown/conflict and exact literal labels only enter `evaluate.ts`, never the scorer. Same-root duplicates remain separate retrieval rows but the report shows distinct source-root groups and does not count them as independent evidence. Contradiction labels are authored evaluation labels; neither method detects semantic contradiction.

The single JSON report includes per-query outputs, macro Recall@1/3/8 over nonempty gold sets (unknown excluded with denominator), unknown-query nonempty counts, exact-literal retention@1/3/8 over cases with a literal actually in the corpus, contradiction both-side coverage@1/3/8, and source-root group counts. Unknown literal cases remain visible per-query and are not counted as positive exact-retention opportunities. Empty-candidate rate is not real refusal/abstention quality. Sixteen synthetic queries cannot establish general superiority; embedding/PPR/model/learning/Spark are `NOT_EVALUATED`.

Mechanism verification (does not import or execute the formal cohort):

```powershell
$env:TEMP = Join-Path $env:LOCALAPPDATA 'Temp'
$env:TMP = $env:TEMP
node --max-old-space-size=128 -e "console.log(require('node:os').tmpdir())"
node --max-old-space-size=128 test/research-bm25.test.ts
node --max-old-space-size=1024 node_modules/typescript/bin/tsc --noEmit --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --erasableSyntaxOnly --verbatimModuleSyntax --allowImportingTsExtensions --skipLibCheck --target ES2023 --module NodeNext test/research-bm25.test.ts research/retrieval-baseline/run.ts
```

Runtime admission: native Temp readback; 128 MiB old-space flag, observed peak RSS <=256 MiB, external 60-second deadline. The focused compiler is a separate layer: fresh free RAM >=3 GiB, 1024 MiB old-space, observed peak RSS <=1536 MiB, external 120-second deadline. Compiler limits are not runtime evidence. Preserve failure logs.

The authorized frozen command completed once with the reviewed hashes and runtime gate. This command is retained for provenance and does not authorize a repeat or cohort change:

```powershell
node --max-old-space-size=128 research/retrieval-baseline/run.ts --run --source-sha256=<reviewed> --cohort-sha256=<reviewed>
```

Source hash is SHA256 of sorted `path + NUL + fileSHA256 + LF` records for all `src/*.ts`, this directory's `.ts` except `cohort.ts`, the mechanism test, package lock and tsconfig; cohort hash covers exact `cohort.ts` bytes. No automatic run, CI/package changes, retry, output-based tuning or cohort replacement is provided. The runner checks hashes, native Temp, heap flag, elapsed time and process peak RSS, and emits its environment and exact source records. A supervising operator enforces the wall deadline for synchronous operations. Outputs go to a fresh native-Temp log file, preserving earlier results.

## Fixed-cohort result and decision

| Metric | AR0 | BM25 |
| --- | --- | --- |
| Macro Recall@1 / @3 / @8 (12 nonempty gold cases) | 72.22% / 95.83% / 95.83% | 47.22% / 66.67% / 66.67% |
| Unknown queries returning any candidates | 0/4 | 2/4 |
| Exact-literal retention@1 / @3 / @8 (7 eligible cases) | 7/7 / 7/7 / 7/7 | 4/7 / 4/7 / 4/7 |
| Contradiction both-side coverage@1 / @3 / @8 | 0/2 / 1/2 / 1/2 | 0/2 / 2/2 / 2/2 |

Root decision: this fixed synthetic cohort does not support replacing production AR0 with BM25. Keep AR0 unchanged and retain BM25 only as a research baseline. BM25 has a local positive on contradiction-side coverage; it also misses Chinese substring, punctuation and emoji literal cases here. Contradiction gold is authored evaluation metadata, not automatic semantic contradiction detection. Shared-root duplicates/supplements do not become independent evidence. Unknown-query nonempty output measures retrieval behavior, not answer correctness or refusal quality. Sixteen synthetic queries do not establish general superiority; elapsed values are not a concurrency-independent performance benchmark.

Local validation layers remain separate: original 26 mechanism fixtures; later 9 affected boundary fixtures plus focused strict TypeScript; one authorized formal 16-query comparison. Do not add these counts. Independent max review closed the P2 snapshot-time budget issue before the frozen comparison. CI for the publication head is pending. No model, embedding, PPR, learning, training or Spark execution occurred, and production ranking/Store/authority/shared interfaces remain unchanged.
