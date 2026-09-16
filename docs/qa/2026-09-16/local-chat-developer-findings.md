# Bounded local browser workflows

Executed in fresh headless Chrome on `http://127.0.0.1:5174`, using `qa-chat=1&qa-role=employee` and `qa-developer=1&qa-role=super_admin`. All non-local HTTP requests were blocked. No external requests were attempted, no page errors occurred, and all writes affected synthetic fixture memory only.

| Scenario | Result | Validated output |
| --- | --- | --- |
| Send direct message | Pass | New body appears in message history; composer clears. |
| Reply | Pass | Reply appears with quote navigation. |
| Search messages | Pass | Search finds the newly sent message. |
| Unpin then repin | Partial / fixture discrepancy | Memory state changed to false then true, but after repinning the open conversation menu still offered **Pin chat**, rather than **Unpin chat**. |
| Create developer key while API remains disabled | Pass | Form saves, one-time value starts `qa_nonfunctional_`, and Done hides it. |
| Revoke developer key | Pass | Row becomes Revoked and its revoke action disappears. |

The pin refresh discrepancy is **not promoted to a confirmed production defect** in this bounded pass: the fixture mutates shared preference objects in memory, which may affect React Query structural sharing. Determining whether this also occurs with serialized backend responses requires a separate reproduction. No actual key was created and no real person received a message.

Evidence: [results](local-chat-developer-results.json), [script](local-chat-developer-browser.mjs), [message screenshot](chat-local-browser.png), [developer screenshot](developer-local-browser.png), [pin-menu text](browser-step-4.txt).

Initial harness runs used incorrect accessible names for Reply/Create key/Revoke key; those selectors were corrected and the flows rerun. Such selector failures are not application defects. Final results above are from the corrected run. This closes only these six bounded browser scenarios, not the wider messaging/developer integration backlog.
