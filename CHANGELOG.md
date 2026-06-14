# Changelog

## [0.4.0](https://github.com/nbialk/quiver-cli/compare/v0.3.0...v0.4.0) (2026-06-14)


### Features

* **commands:** add review command and refine cp commit assistant ([47ab3d9](https://github.com/nbialk/quiver-cli/commit/47ab3d9ad4fbac93ebe4691f5dc5c1853ce1715e))

## [0.3.0](https://github.com/nbialk/quiver-cli/compare/v0.2.0...v0.3.0) (2026-06-14)


### Features

* **cli:** notify when a newer version is available ([3d81668](https://github.com/nbialk/quiver-cli/commit/3d8166845e1bdc808a98c14aae20966fa604f928))

## [0.2.0](https://github.com/nbialk/quiver-cli/compare/v0.1.0...v0.2.0) (2026-06-13)


### Features

* **catalog:** add improve skill ([a86022f](https://github.com/nbialk/quiver-cli/commit/a86022fe826956dea779c715150be8313daf95b2))
* **check:** summarize how many entries were checked ([9f1c5e1](https://github.com/nbialk/quiver-cli/commit/9f1c5e18786cc1d8ed4f8e892d85b5f8cfb8b616))


### Bug Fixes

* **upstream:** abort when the catalog is not writable ([00aa545](https://github.com/nbialk/quiver-cli/commit/00aa545083ec4803781dd650ccc1d77233fe72bc))

## 0.1.0 (2026-06-13)


### Features

* **agents:** add posthog and langfuse MCP servers, switch context7/notion to HTTP ([506ca5b](https://github.com/nbialk/quiver-cli/commit/506ca5b1b4b4ec1f887cae801493b98a69f34555))
* **catalog:** restructure skills into categories with upstream origins ([75d9f51](https://github.com/nbialk/quiver-cli/commit/75d9f514e41600b764e4193d90e04311855d3581))
* **catalog:** support remote GitHub catalogs with token auth ([db12b4b](https://github.com/nbialk/quiver-cli/commit/db12b4be9bf102a3e9ab20315a0bcf16805cc427))
* **cli:** add command selection, change MCP default to none ([739740f](https://github.com/nbialk/quiver-cli/commit/739740f52579ae893fdcbef7b63729f90f062a19))
* **cli:** add list command with MCP tool counts ([52a9d6b](https://github.com/nbialk/quiver-cli/commit/52a9d6bfa4adc9af61924031cd80b98381987b1d))
* **cli:** add update command to pull catalog content into the repo ([0e921a6](https://github.com/nbialk/quiver-cli/commit/0e921a6aa523364546540931678ac37f9512917e))
* **cli:** add upstream pull to fetch skill updates into the catalog ([4c74a9c](https://github.com/nbialk/quiver-cli/commit/4c74a9c23cc6121c5ec8ffd85c57fa743fa98a7c))
* **cli:** add version command and -v/--version flags ([386b4bf](https://github.com/nbialk/quiver-cli/commit/386b4bffa54ed911e87eecbc4b8b03557d1ecd68))
* **cli:** interactive checkbox UI for MCP selection ([f7863e5](https://github.com/nbialk/quiver-cli/commit/f7863e533164478f12565c89db8af2c81835646b))
* **cli:** interactive MCP server selection on init ([9efb137](https://github.com/nbialk/quiver-cli/commit/9efb137c4095228f251218b3c89801fabdd69231))
* **cli:** interactive skill selection and grouped prompts ([9e90296](https://github.com/nbialk/quiver-cli/commit/9e902961b40e2c0582e4d56a5d76c4e5a2c582c5))
* **cli:** polish init UX with spinner and quiet sync summary ([8c1ad73](https://github.com/nbialk/quiver-cli/commit/8c1ad736f9bd8e816d8b736f19b1543ca754292e))
* **cli:** provider selection for generated configs ([6d33724](https://github.com/nbialk/quiver-cli/commit/6d33724246b42e00c487084c283b4e9b39b308ba))
* **cli:** rewrite nb-agents as quiver-cli in TypeScript ([0b5fa8b](https://github.com/nbialk/quiver-cli/commit/0b5fa8bf77024ec310061320c7a51496428573e7))
* portable nb-agents installer with skills, commands and sync ([4ebc7ed](https://github.com/nbialk/quiver-cli/commit/4ebc7ed8011f61f3fc32b1c7cf2a093de79d0ed9))
* **skills:** add consolidated posthog skill ([0123255](https://github.com/nbialk/quiver-cli/commit/01232558462bcbab46fbd504c6993af8bdb4eb7c))
* **skills:** add find-skills, agent-browser, and skill-creator ([f059581](https://github.com/nbialk/quiver-cli/commit/f059581244e2465d220624e64cabb8706d71fb1c))


### Code Refactoring

* **skills:** consolidate design skills into impeccable ([5fb95c9](https://github.com/nbialk/quiver-cli/commit/5fb95c9dfd71a9229a66437ed42b95f8c8e1a8a2))
* **skills:** remove deprecated normalize skill ([298c08a](https://github.com/nbialk/quiver-cli/commit/298c08ac399ce85d57d5132dfe7a5ad6abe0a45f))


### Documentation

* **agents:** list configured MCP servers in README ([fe3f08c](https://github.com/nbialk/quiver-cli/commit/fe3f08c7f9c7a70585d2da82a57835f5b77326fb))
* **readme:** add feature overview and quick start ([b49dfdd](https://github.com/nbialk/quiver-cli/commit/b49dfdd76a53b42f2e8b1d87f3439fa01f5fe031))
* **readme:** document quiver-cli commands, drift and secrets workflow ([d22335c](https://github.com/nbialk/quiver-cli/commit/d22335c26d5adef72f6a14e9711f48bd15eec0ff))
* **readme:** document update, list, upstream pull and provider selection ([09ae6c2](https://github.com/nbialk/quiver-cli/commit/09ae6c267bfeb9123c155c057ee416c107d61180))
