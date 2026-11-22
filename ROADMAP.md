# Roadmap

| Stage | Scope | Acceptance criterion |
| --- | --- | --- |
| 0.9 · implemented | Compose three types of post and validate selected destinations | Unsupported combinations are flagged before submission. Per-destination captions are checked against the outgoing content. |
| 0.9 · tested locally | Recover and review jobs | Mocked provider tests distinguish confirmed outcomes from ambiguous ones. Cancelling or moving a scheduled job is covered by the integration suite. |
| Next | One controlled live account per provider path | With explicit owner approval, record the consent flow, target account, media format and actual provider result. Record private visibility where supported. |
| Next | Scheduling under real operating conditions | Document what the user sees after sleep, restart and missed execution times; compare displayed state with the destination. |
| Later | Browser regression coverage | Repeat the current desktop/mobile smoke check automatically on text, photo and video modes and keyboard navigation. |
