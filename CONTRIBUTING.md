# Contributing to Iris Agent

Thank you for helping improve Iris Agent.

## Development setup

Requirements:

- Node.js `>=22.13.0`
- npm or Yarn

```sh
git clone https://github.com/4onstudios/iris-agent.git
cd iris-agent
npm install
```

Run validation before opening a pull request:

```sh
npm run typecheck
npm run build
npm test
```

## Pull requests

- Create a focused branch from `main`.
- Explain the problem, approach, and validation in the pull request.
- Add or update tests for behavior changes.
- Update documentation when public behavior or configuration changes.
- Never commit credentials, tokens, `.env` files, or generated secrets.

## Commit and review guidance

Keep commits focused and use clear imperative messages. Maintainers may request
changes before merging. By contributing, you agree that your work is licensed
under the repository's MIT License.
