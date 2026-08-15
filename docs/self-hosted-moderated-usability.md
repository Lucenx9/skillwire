# Self-hosted moderated usability protocol

This is the normative moderator protocol for the external T161 release
certification. Running repository tests does not create participant evidence and
does not satisfy this protocol. Test fixtures use
`evidenceKind: synthetic-fixture`; only a completed external session may use
`certified-observation`.

## Freeze the cohort and candidate

Before recruiting, freeze one immutable release identity for the whole cohort:

- release version and exact tag `self-hosted-v<package.version>`;
- the annotated tag's 40-hex target commit;
- the exact seven published asset filenames, byte sizes, and SHA-256 values;
- the SHA-256 of the published `distribution/self-hosted/README.md` used by
  every participant.

Recruit exactly ten independent participants who have never installed SkillWire.
Pre-screening happens before cohort assignment. Every assigned participant must
use a clean supported Ubuntu 24.04, Debian 12, or Debian 13 environment on
`amd64` or `arm64` with rootful or rootless Docker. Assign only a privacy-safe
opaque participant ID and a distinct opaque environment ID. Do not record a
name, email address, account identity, repository identity, prompt, response,
credential, client login state, or unrelated profile content.

After the ten IDs are frozen, a participant cannot be replaced, rerun, or
excluded. A timeout, abandonment, unrecovered error, dirty starting state, or
eligibility discrepancy is a failed first attempt. The evidence schema includes
`exclusionReason` so an invalid collection attempt cannot be hidden, but the
semantic validator rejects an exclusion inside the frozen cohort.

## Fixed starting state

Immediately before the UTC start timestamp, the moderator records only the
following booleans and supported environment identity:

- SkillWire has never been installed by the participant;
- no SkillWire service or retained SkillWire data exists;
- the selected ordinary Codex or Claude profile has no SkillWire integration;
- the environment is clean, supported, and unique to this participant;
- this is attempt number one and is not a replacement attempt.

The moderator then gives exactly this instruction:

> Open the published SkillWire self-hosted quickstart and use only that document
> to verify the release, install SkillWire with one ordinary Codex or Claude
> client, determine the final installation state and next safe recovery action,
> complete the documented SkillWire tool journey, and clean up as documented.
> Tell me when you are finished or cannot continue.

Start the UTC timer when the participant opens the frozen quickstart. The target
is 900,000 milliseconds. The moderator must not provide a command, correction,
procedural hint, alternative document, or service-internal explanation.

## Observation milestones

Record only status and public error codes for each milestone. Do not transcribe
terminal output or participant content.

1. The exact archive, architecture manifest, signature bundle, trust policy,
   annotated tag, and source commit are verified.
2. First-party setup reaches service readiness and integrates one normal Codex
   or Claude profile without a wrapper or alternate production profile.
3. From the final setup or doctor output, the participant identifies the
   installation state and the next safe recovery action without inspecting
   service internals.
4. The participant discovers exactly `search_skills`, `load_skill`,
   `get_skill_resource`, `import_repository`, `list_repositories`, and
   `remove_repository`.
5. The participant completes MCP search, loads the exact selected skill, and
   uses the optional resource step when the selected skill exposes a resource;
   otherwise that one step is recorded `not-applicable`.
6. The participant completes the documented cleanup and the moderator verifies
   that its disposable resources are absent.

For each milestone use `passed`, `failed`, `timeout`, or `abandoned`;
`not-applicable` is permitted only for the optional resource milestone. Record
the UTC end timestamp and the exact derived duration. Stop at 900,000
milliseconds if the journey is not complete. An abandonment, timeout, any
required milestone that is not passed, unverified cleanup, or an unrecovered
public error makes `completed` false.

## Assistance rule

An intervention is any undocumented command, correction, or procedural
instruction required from the moderator. Record its UTC time, category,
milestone, and privacy-safe public code. A participant with any intervention is
not unassisted even if the journey later completes.

A clarification is non-intervening only when it identifies the location of
information already visible in the frozen quickstart and supplies no command,
correction, interpretation, ordering, or procedural guidance. Record it with
criterion `visible-document-location-only`, the frozen document path, and its
public section ID. Anything more is an intervention. Clarifications never erase
an error, timeout, or intervention.

## Evidence and calculation

Serialize the complete cohort with
`distribution/self-hosted/moderated-usability.schema.json`, then run the
semantic validator exported by `src/onboarding/domain/moderated-usability.ts`.
All ten records must carry the same candidate, seven-asset set, and
documentation identity. Participant and environment IDs must be unique. The
validator recomputes completion, unassisted status, durations, release identity,
and aggregate values; supplied summary booleans are not trusted.

- **SC-001 (95%)**: exactly 10 of 10 assigned participants must complete the
  required onboarding journey within 900,000 milliseconds. Nine of ten is 90%
  and fails this criterion.
- **SC-014 (90%)**: at least 9 of 10 must complete without a moderator
  intervention. A permitted location-only clarification is recorded separately
  and is not an intervention.

No synthetic fixture, partial cohort, replacement attempt, excluded failure, or
recalculated denominator is release evidence. Preserve only the privacy-safe
schema fields and redacted public codes required for external review.
