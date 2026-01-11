# Lessons Learned

## What went well
- Handlebars with strict mode made it easy to guard against missing placeholders.
- Caching compiled templates keeps the renderer simple and quick for repeated calls.

## What was tricky
- Resolving template paths had to work for both src and dist builds; walking up to package.json kept it robust.

## Unexpected discoveries
- The project already depended on Handlebars, so no extra dependency work was needed.

## Recommendations
- Keep prompt examples free of unused `{{...}}` patterns so unresolved placeholder checks stay meaningful.
- Add new templates to the `files` list when publishing artifacts that depend on them.

## Time spent per phase
- Scoping: ~0.2h
- Implementation: ~1.0h
- Verification: ~0.3h
- Review/Polish: ~0.3h
