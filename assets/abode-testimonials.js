// Testimonials section: reveals "Read full review" on clamped quotes, opens
// them in a dialog, and drives the native scroll-snap carousel arrows.
if (!customElements.get("abode-testimonials")) {
  class AbodeTestimonials extends HTMLElement {
    connectedCallback() {
      this.track = this.querySelector("[data-testimonials-track]");
      this.nav = this.querySelector("[data-testimonials-nav]");
      this.prev = this.querySelector("[data-testimonials-prev]");
      this.next = this.querySelector("[data-testimonials-next]");
      this.dialog = this.querySelector("[data-testimonials-dialog]");
      this.dialogContent = this.querySelector(
        "[data-testimonials-dialog-content]",
      );
      if (!this.track) return;

      this.update = this.update.bind(this);
      this.onClick = this.onClick.bind(this);
      this.onBlockSelect = this.onBlockSelect.bind(this);

      this.addEventListener("click", this.onClick);
      this.track.addEventListener("scroll", this.update, { passive: true });
      document.addEventListener("shopify:block:select", this.onBlockSelect);

      // Re-measure when the layout changes (resize, fonts loading, editor tweaks).
      this.resizeObserver = new ResizeObserver(this.update);
      this.resizeObserver.observe(this.track);
      this.update();
    }

    disconnectedCallback() {
      this.removeEventListener("click", this.onClick);
      this.track?.removeEventListener("scroll", this.update);
      document.removeEventListener("shopify:block:select", this.onBlockSelect);
      this.resizeObserver?.disconnect();
    }

    update() {
      this.querySelectorAll(
        "[data-testimonials-track] [data-testimonial]",
      ).forEach((card) => {
        const quote = card.querySelector("[data-testimonial-quote]");
        const button = card.querySelector("[data-testimonial-open]");
        if (!quote || !button) return;
        button.hidden = quote.scrollHeight <= quote.clientHeight + 1;
      });

      if (!this.nav) return;
      const { scrollLeft, scrollWidth, clientWidth } = this.track;
      const scrollable = scrollWidth > clientWidth + 1;
      this.nav.hidden = !scrollable;
      this.prev.disabled = scrollLeft <= 1;
      this.next.disabled = scrollLeft + clientWidth >= scrollWidth - 1;
    }

    onClick(event) {
      const open = event.target.closest("[data-testimonial-open]");
      if (open)
        return this.openDialog(open.closest("[data-testimonial]"), open);

      if (event.target.closest("[data-testimonials-close]"))
        return this.dialog.close();
      if (event.target === this.dialog) return this.dialog.close(); // backdrop click

      if (event.target.closest("[data-testimonials-prev]"))
        return this.scrollByPage(-1);
      if (event.target.closest("[data-testimonials-next]"))
        return this.scrollByPage(1);
    }

    scrollByPage(direction) {
      const card = this.track.querySelector("[data-testimonial]");
      const gap = parseFloat(getComputedStyle(this.track).columnGap) || 0;
      const step = card ? card.offsetWidth + gap : this.track.clientWidth;
      const perPage = Math.max(
        1,
        Math.floor((this.track.clientWidth + gap) / step),
      );
      this.track.scrollBy({ left: direction * step * perPage });
    }

    openDialog(card, trigger) {
      if (!card || !this.dialog) return;

      const clone = card.cloneNode(true);
      clone.removeAttribute("id");
      clone.removeAttribute("data-testimonial");
      clone
        .querySelectorAll("[data-testimonial-open]")
        .forEach((el) => el.remove());
      [...clone.attributes]
        .filter((attr) => attr.name.startsWith("data-shopify"))
        .forEach((attr) => clone.removeAttribute(attr.name));

      const heading = clone.querySelector(".abode-testimonial__heading");
      if (heading) {
        heading.id = `${this.dialog.id || "AbodeTestimonialDialog"}-heading`;
        this.dialog.setAttribute("aria-labelledby", heading.id);
      } else {
        this.dialog.removeAttribute("aria-labelledby");
      }

      this.dialogContent.replaceChildren(clone);
      this.dialog.addEventListener("close", () => trigger.focus(), {
        once: true,
      });
      this.dialog.showModal();
    }

    onBlockSelect(event) {
      const card = this.track.querySelector(
        `[data-shopify-editor-block*='"id":"${event.detail.blockId}"']`,
      );
      card?.scrollIntoView({ block: "nearest", inline: "start" });
    }
  }

  customElements.define("abode-testimonials", AbodeTestimonials);
}
