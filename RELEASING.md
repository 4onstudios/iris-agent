# Releasing Iris Agent

Releases are published from a clean, validated `main` checkout.

1. Update the version in `package.json` and refresh lockfiles if dependencies changed.
2. Run `npm run typecheck`, `npm run build`, and `npm test`.
3. Inspect the package with `npm pack --dry-run`.
4. Create and push a version commit and Git tag.
5. Publish the scoped package:

   ```sh
   npm login
   npm publish --access public
   ```

The publisher must have access to the `@4onstudios` npm scope. Verify the
published package and installation with both npm and Yarn after release.
