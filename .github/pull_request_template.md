# Pull Request Checklist

Thanks for contributing to Sonic! Please complete this checklist and remove items that don't apply.

## Description

<!-- Summarize the changes and motivation -->

## Testing Done

<!-- List manual testing steps and automated tests added -->

---

## Database Migration Checklist (if applicable)

- [ ] Schema version incremented
- [ ] `migrate_vN_to_vN+1()` function implemented
- [ ] Migration is transactional
- [ ] Pre-migration backup performed
- [ ] Post-migration integrity checks added
- [ ] Migration fixtures created for prior versions
- [ ] Rollback path documented
- [ ] Not applicable (no schema changes)

## Security Checklist

- [ ] No new user input vulnerabilities (SQL injection, path traversal, etc.)
- [ ] File operations validated and sanitized
- [ ] No secrets or credentials committed
- [ ] External dependencies reviewed
- [ ] FFmpeg arguments remain constrained (no arbitrary args exposed)

## Sidecar Compatibility Checklist (if applicable)

- [ ] Sidecar schema version checked
- [ ] Backward compatibility maintained or migration provided
- [ ] Forward compatibility handled gracefully
- [ ] Hash validation preserved
- [ ] Not applicable (no sidecar changes)

## Testing Checklist

- [ ] Unit tests added/updated
- [ ] Integration tests added/updated
- [ ] E2E tests added/updated (for UI changes)
- [ ] Performance benchmarks considered (for large datasets)
- [ ] Accessibility verified (for UI changes)

---

## Breaking Change?

<!-- Does this require users to take action or break existing functionality? -->

- [ ] No
- [ ] Yes - database schema
- [ ] Yes - API contract
- [ ] Yes - configuration format
- [ ] Yes - sidecar format

## Additional Notes

<!-- Anything else reviewers should know? -->
