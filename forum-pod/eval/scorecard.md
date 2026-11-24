# Opinion map scorecard

Fixture: maine-budget-gap-2028-29

Name differences:

- Spec tables are described as D1. The test state keeps groups, posts, comments, members, and civic_reports in the Family Durable Object SQLite database. There is no separate D1 database on podlink-ai-test-state. The seed plan uses thread_configs, comment_extractions, thread_themes, claim_checks, and place_taps in that same database. Those tables are not created on the live DO in this deploy.
- groups has no is_fixture column and no place column. The seed plan sets is_fixture = 1 and place = Maine on the thread config, and would hide the group from listings and the auto-report scan unless ?show_fixtures=1. The live route does not insert the group: it checks x-sim-token and returns stored false. The map is drawn on the observe page only when that query is present.
- group_comments has no parent_id and no image column. Replies stay comments on the opening post, and image descriptions are appended to the stored text. The public observe payload omits that text.
- The internal gate already on this worker is the x-sim-token header checked against SIM_INTERNAL_TOKEN, the same check as /internal/sim. The seed and run routes use that header. No new secret is added.
- CIVIC_EXTRACT_MODEL is not a binding on the test worker. The code default is @cf/meta/llama-3.3-70b-instruct-fp8-fast at temperature 0. Asking that model for JSON mode returned broken keys, so the call parses a JSON object from the reply instead of setting response_format. The 8B model is not used. CIVIC_REPORT_AUTO_AI is left at 0. A new plain-text binding was not uploaded, because a full script settings replace can drop secrets.
- The fixture has no thread_config.themes key. The theme list is the union of circle themes, process_themes, and unplaced_themes, with labels from theme_labels.
- The fixture PRO circle label is longer than five words. The page shows Protect residents.
- LD 307 has no thread_configs row. A missing mode keeps today's single-proposal marker, so the three meters stay. open_question skips the marker and the meter. single_proposal reads stance_phrases from the thread config.
- Bridge drafts do not fit an existing statement source column. They are stored as thread config JSON with source = bridge and approved = false. The public page does not show them until a steward approves.
- CIVIC_PUBLISH_VERBATIM_COMMENTS is not set on the test worker. It is treated as off. Comment text stays off the public page.
- Authors are stored as res-001 and shown as Resident 001. R001 is not written into public HTML.
- There is no package.json at the forum-stack root. npm run eval:opinion-map is defined on forum-pod.

## Tests

- gold Gold themes reproduce author_region_counts: pass — exact
- unit-span Claim span must be an exact substring: pass — kept 1, dropped 1
- unit-theme Unknown theme moves to suggestions: pass — fraud_waste_audit
- unit-unknown Unknown fields fail validation: pass — unknown_field:note
- unit-json Invalid JSON is detected and a JSON object can be recovered: pass — not_json
- unit-tone Tone outside the list fails: pass — bad_tone
- unit-marker-open Open question skips the phrase marker: pass
- unit-marker-oppose Single proposal checks oppose before support: pass
- unit-marker-support Single proposal support phrase: pass
- unit-marker-missing Missing mode does not run as single_proposal: pass
- unit-prompt Extraction prompt omits the author key: pass
- unit-seed Seed plan is idempotent and hides author keys: pass — Resident 001
- 1 Author placement agreement: fail — 83 of 121 authors match (need 103). model @cf/meta/llama-3.3-70b-instruct-fp8-fast, prompt extract-v1, failures 0
- 2 Center authors: fail — R007=CUT+REV+PRO R033=CUT+REV
- 3 Region counts: fail — CUT got 63 gold 46; venting got 28 gold 43; process got 4 gold 7; CUT+REV+PRO got 1 gold 2; CUT+REV got 4 gold 0
- 4 Theme recall: fail — noncitizen_benefits got 17 gold 13; cut_hhs got 19 gold 9; second_home_tax got 8 gold 6; cut_general got 13 gold 5; property_tax_relief got 1 gold 5; tax_high_earners got 6 gold 3; tax_relief_residents got 4 gold 3; across_board_cut got 4 gold 3; cut_education got 12 gold 3; cut_specific_items got 4 gold 3; protect_services got 1 gold 3
- 5 Pushback: fail — second_home_tax 8 for, 5 against; new_taxes 0
- 6 Tone: pass — 109 of 129 comments agree on constructive vs not
- 7 Claims: pass — K02 routed
- 8 Hallucination guard: pass — zero bad spans
- 9 Determinism: pass — two placement runs
- 10 Count guard: pass — wrong number dropped
- 11 Privacy: pass — no author keys and no comment text
- 12 Venn: pass — html and screenshots
- bridge Bridge statements: pass — Cut Health Services | Reduce General Spending | Tax Non Resident Homes | Cut Education Funding | Stop Cosmetic Projects

## Bridge statements

- Cut Health Services (approved: false)
- Reduce General Spending (approved: false)
- Tax Non Resident Homes (approved: false)
- Cut Education Funding (approved: false)
- Stop Cosmetic Projects (approved: false)
