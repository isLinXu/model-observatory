---
title: Youtu-FT-V1
kind: project
stage: shipped
tags: [后训练, MoE, 轻量模型]
updated: 2026-11-02
links:
  - hf_model:gatilin/Youtu-FT-V1-35B-A3B
  - hf_model:gatilin/Youtu-FT-V1-4B
  - hf_model:gatilin/Youtu-FT-V1-9B
  - hf_space:gatilin/Youtu-VL-demo
---
# Youtu-FT-V1

Youtu 系列的后训练版本，按参数规模分三档发布：35B-A3B（MoE）与 9B、4B 稠密版。

- 与 Youtu-LLM 论文**没有对应关系**，两者是各自独立的工作，注册表不把二者连成一条研究线。
- `hf_space:` 指向的 demo Space 仍在运行，但本站没有 Space 来源可核对，页面显示「未核对」而不是「已失效」。
- 上游 Youtu-VL 权重属第三方仓库，本期范围外；若 demo 依赖的是私有仓库，则不进注册表——本仓库与其发布出的 JSON 都是公开的。
