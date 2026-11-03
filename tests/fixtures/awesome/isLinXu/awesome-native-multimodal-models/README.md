<div align="center">

# 🤖 Awesome Native Multimodal Models

<p align="center">
  <a href="https://github.com/your-username/Awesome-Native-Multimodal-Models/actions">
    <img src="https://github.com/your-username/Awesome-Native-Multimodal-Models/actions/workflows/deploy.yml/badge.svg" alt="Build & Deploy"/>
  </a>
  <img src="https://img.shields.io/badge/Papers-400%2B-blue?style=for-the-badge" />
  <img src="https://img.shields.io/badge/Models-111%2B-green?style=for-the-badge" />
  <img src="https://img.shields.io/badge/Landmarks-26-orange?style=for-the-badge" />
  <img src="https://img.shields.io/badge/Updated-2026--03-brightgreen?style=for-the-badge" />
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" />
  <img src="https://img.shields.io/badge/PRs-Welcome-ff69b4?style=for-the-badge" />
</p>

<p align="center">
  <b>A comprehensive, auto-validated collection of <em>Native Multimodal Models</em> —<br/>
  models with <em>unified tokenization</em>, <em>end-to-end cross-modal training</em>,<br/>
  and <em>shared computation paths</em> across text, image, audio, and video.<br/>
  Covering 2017–2026 · Interactive D3.js visualizations · 17-rule CI/CD validation.</b>
</p>

> 💡 **"Native Multimodal"** = shared computation paths + unified tokenization + end-to-end cross-modal training.
> Distinguished from modular MLLMs (e.g., LLaVA) that add a visual adapter on top of a frozen LLM.

🔗 **Related Repos:** &nbsp;
[Awesome-Unified-Multimodal-Models](https://github.com/AIDC-AI/Awesome-Unified-Multimodal-Models) ·
[John-Ge/Awesome-Native-Multimodal-Models](https://github.com/John-Ge/Awesome-Native-Multimodal-Models) ·
[Awesome-Multimodal-LLMs](https://github.com/BradyFU/Awesome-Multimodal-Large-Language-Models)

</div>

---

## 🌐 Interactive Visualizations

> Auto-generated on every push via GitHub Actions · Hosted on GitHub Pages

| 📊 Page | 🔗 Link | Description |
|---------|---------|-------------|
| 🌲 Architecture Taxonomy | [taxonomy.html](https://islinxu.github.io/awesome-native-multimodal-models/taxonomy.html) | Collapsible D3.js tree · 5 branches · 111 leaf models · hover for paper links |
| 📅 Model Timeline | [timeline.html](https://islinxu.github.io/awesome-native-multimodal-models/timeline.html) | Swim-lane timeline 2017–2026 · zoom & pan · category filters · minimap |
| 🔍 Validation Report | [validation_report.html](https://islinxu.github.io/awesome-native-multimodal-models/validation_report.html) | Data quality dashboard · Chart.js · JSON export |
| 🏠 Index | [index.html](https://islinxu.github.io/awesome-native-multimodal-models/index.html) | Landing page with live stats |


## 🤔 What is Native Multimodal?

**Native Multimodal Models** are models that natively handle multiple modalities — text, image, audio, video — within a **unified architecture**, as opposed to modular, adapter-based approaches.

| Aspect | Native Multimodal | Modular MLLM |
|--------|-------------------|--------------|
| Tokenization | ✅ Unified token space for all modalities | ❌ Separate encoders per modality |
| Computation | ✅ Shared Transformer across modalities | ❌ Frozen LLM + adapter layers |
| Training | ✅ End-to-end cross-modal pre-training | ❌ Two-stage adapter tuning |
| Generation | ✅ Native multi-modal output | ❌ External decoder required |
| Examples | Chameleon, Emu3, Janus-Pro, BAGEL | LLaVA, InstructBLIP, MiniGPT-4 |

## 🔍 Survey Papers

> 💡 **Recommended reading order for newcomers:**
> 1. VQ-VAE (tokenization fundamentals) → 2. CLIP (contrastive pretraining) → 
> 3. BLIP-2 (generative pretraining) → 4. Chameleon (early-fusion) → 
> 5. Janus-Pro (decoupled AR) → 6. BAGEL (hybrid unified) → 7. The surveys below

| Title | Venue | Date | Paper | Code |
|-------|-------|------|-------|------|
| A Comprehensive Survey of Multimodal Pretraining, Native Foundation Models, and Omni-Native Architectures | - | 2025 | [PDF](native-multimodal_survey.pdf) | - |
| **Unified Multimodal Understanding and Generation Models: A Survey** | arXiv | 2025/05 | [arXiv:2505.02567](https://arxiv.org/abs/2505.02567) | [GitHub](https://github.com/AIDC-AI/Awesome-Unified-Multimodal-Models) |
| A Survey on Large Multimodal Reasoning Models | arXiv | 2025/05 | [arXiv:2505.04921](https://arxiv.org/html/2505.04921v1) | - |
| Vision Encoders in Vision-Language Models: A Survey | Jina AI | 2025 | [PDF](https://jina.ai/vision-encoder-survey.pdf) | - |
| A Survey on Mechanistic Interpretability for Multi-Modal Foundation Models | arXiv | 2025/02 | [arXiv:2502.17516](https://arxiv.org/html/2502.17516v1) | - |
| Representation Potentials of Foundation Models for Multimodal Tasks | arXiv | 2025/10 | [arXiv:2510.05184](https://arxiv.org/html/2510.05184v1) | - |
| Discrete Tokenization for Multimodal LLMs: A Survey | arXiv | 2025/07 | [arXiv:2507.22920](https://arxiv.org/pdf/2507.22920) | - |
| A Survey of Architectural Design in Large Vision-Language Models | TechRxiv | 2025 | [PDF](https://www.techrxiv.org) | - |
| A Comprehensive Survey of Efficient Multimodal Learning | TechRxiv | 2025 | [PDF](https://www.techrxiv.org/users/1011886/articles/1372030) | - |
