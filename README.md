# mass-merge

A script for mass-approving and merging Dependabot pull requests

### Usage

```
GITHUB_TOKEN=*** npx mass-merge <organization> <"commit message"> <author> [--ignore-checks] [restrict-to-repos]
```

Example:

```
npx mass-merge discourse "Bump @babel/traverse" dependabot
```
