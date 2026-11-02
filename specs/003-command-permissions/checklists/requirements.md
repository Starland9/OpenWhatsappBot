# Specification Quality Checklist: Permissions par commande

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-30
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- Les noms de commandes (`.vv`, `.setcmd`...), SUDO, LID, `onlyGroup`/`onlyPm` sont des termes du domaine visibles par le propriétaire (déjà employés par la spec 002), pas des détails d'implémentation.
- FR-006 fixe l'ordre de décision ; US2 (scénarios 1 à 6) et US3 (scénarios 2 à 4) en couvrent chaque branche.
- Menu et aide : tranché avec le propriétaire le 2026-10-30 (FR-028, FR-029). Plus aucune hypothèse en attente.
