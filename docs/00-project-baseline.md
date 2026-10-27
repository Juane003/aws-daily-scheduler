# Stage 0 — Project baseline

**Requirements:** Q1 · **Depends on:** — · **CLAUDE.md:** Stack, §1

## Goal

A repository where every later stage can be built, type-checked, linted and tested with one command, and where the architecture rules of §1 are enforced automatically rather than by review only.

## Already in place (initial commit)

- TypeScript 5.9, ES modules, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` (`tsconfig.json`).
- Vitest, ESLint with `typescript-eslint`.
- `src/{domain,application,infrastructure}` folder skeleton.
- `DomainError` base class with a test.

## Work

1. **Layer boundaries as lint rules.** Add `no-restricted-imports` overrides in `eslint.config.js`:
   - `src/domain/**`: may not import from `application/`, `infrastructure/`, `@aws-sdk/*`, `pg`, or Node built-ins with I/O.
   - `src/application/**`: may not import from `infrastructure/`, `@aws-sdk/*`, `pg`.
   - Ban `Date.now()` / `new Date()` with no arguments in `domain/` and `application/` (`no-restricted-syntax`) — time comes from `Clock`.
2. **Exhaustiveness helper.** `src/domain/assertNever.ts` used in every `default:` of a discriminated-union `switch`.
3. **Test layout.** Vitest projects or name patterns that separate fast tests (`tests/domain`, `tests/application`) from container-backed ones (`tests/infrastructure`), e.g. `npm test` (unit) and `npm run test:integration`.
4. **CI.** GitHub Actions workflow: `npm ci` → `typecheck` → `lint` → unit tests; integration tests in a second job with Docker available.
5. **Node version.** `.nvmrc` = 22 and `engines >= 22`, which satisfies the Lambda runtime requirement (Node 20+). Lambda runtime will be `nodejs22.x`.

## Tests

- A deliberately bad import in a fixture file is rejected by `npm run lint` (verified once, then removed).

## Definition of done

- [ ] `npm run typecheck && npm run lint && npm test` green locally and in CI.
- [ ] Layer-boundary lint rules active.
- [ ] Unit and integration test commands separated.

## Decisions

- Test runner: Vitest (`CLAUDE.md` Stack).
