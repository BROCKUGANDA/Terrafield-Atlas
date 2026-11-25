# Legal and licensing review pack

Status: **internal readiness review complete; qualified counsel sign-off outstanding**.

This document records what was reviewed in the repository and what still requires a qualified lawyer, the data provider, or the deployment operator. It is not legal advice and does not certify regulatory compliance.

## 1. reviewed repository artifacts

| Area | Evidence | Internal finding |
| --- | --- | --- |
| Product/marketing claims | `src/app/(marketing)/*`, `README.md` | No certification, NASA endorsement, yield, harvest, or profit guarantee is claimed. Marketing states current capability and limitations. |
| Scientific claims | `docs/METHODOLOGY.md`, `docs/LIMITATIONS.md`, report methodology text | Correlation is not presented as causation; missing data is counted; forecasts and market prices are not fabricated. |
| Data source licenses | `docs/DATA_SOURCES.md`, `src/lib/seeds.ts` | Each source records provider, product, license, attribution, access conditions, and limitations. Earthdata science files and commercial feeds are marked not configured. |
| User terms | `src/app/(marketing)/terms/page.tsx` | Acceptable use, tenant access, plan limits, integration responsibilities, scientific limitations, and no-endorsement statement are present. |
| Privacy | `src/app/(marketing)/privacy/page.tsx` | Account, farm, observation, usage, cookie, and integration data categories are disclosed. |
| Secret handling | `src/lib/account-security.ts`, `src/lib/webhook-crypto.ts`, `.gitignore` | Passwords are hashed, webhook secrets encrypted, and no committed secret values were found. Rotate any secret previously present in deployment history. |
| Subscription language | `src/lib/commercial.ts`, `src/app/(marketing)/pricing/page.tsx` | Plans are configurable, no live payment provider is claimed, and pricing is described as workspace configuration. |

## 2. provider licensing checks

- **NASA POWER, GIBS, EONET, MAAP STAC:** NASA open data; attribution is retained. Verify each collection's terms before commercial redistribution of derived products.
- **ISRIC SoilGrids 2.0:** CC BY 4.0; attribution retained; modeled values clearly labeled.
- **FIRMS:** attribution retained; `MAP_KEY` access conditions must be reviewed with NASA FIRMS before production use.
- **FAO/crop literature:** citations are stored in the versioned crop catalogue. Verify commercial use rights for any reproduced tables or text in customer-facing materials.
- **Third-party runtime packages:** dependency audit is clean; retain a software bill of materials and monitor advisories.

## 3. open legal questions requiring counsel or operator action

1. **Jurisdiction and entity:** identify the contracting entity, governing law, venue, and tax residency for customer agreements.
2. **Data controller/processor roles:** confirm whether the operator is controller or processor for each customer category, especially cooperative and institutional deployments.
3. **Data processing agreement:** customer-facing DPA with sub-processors, regions, breach notification, audit rights, and deletion/return terms.
4. **Retention and deletion:** define account, farm, observation, audit, and raster artifact retention periods and an executable deletion workflow.
5. **Children and vulnerable data:** confirm that the service is not directed at minors and decide whether special agricultural or location data requires additional consent.
6. **Professional advice disclaimer:** counsel should confirm the existing "decision support, not agronomic advice" wording is sufficient for target markets.
7. **Consumer and distance-selling rules:** review pricing presentation, cancellation, renewal, and refund disclosures once a payment provider is selected.
8. **Insurance/liability cap:** align terms with the operator's insurance coverage and institutional procurement requirements.
9. **Export controls and sanctions:** confirm Earth-observation data access complies with customer countries and sanctions rules.
10. **Accessibility and sector regulation:** confirm applicable accessibility standard and any public-sector procurement requirements.

## 4. release gate

The repository is prepared for legal review: claims, licensing, privacy, and terms are documented and traceable. The release gate remains **not passed** until items 1–10 receive qualified sign-off and the resulting changes are applied to the terms, privacy notice, DPA template, and onboarding flow.
