# agent_configs — centralized agent config, symlinked/seeded into place.
# Driven by ./manifest. See README.md.

REPO := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
# Non-comment, non-blank manifest lines.
ROWS := grep -vE '^[[:space:]]*(\#|$$)' '$(REPO)/manifest'

.PHONY: help install status uninstall doctor
.DEFAULT_GOAL := help

help:
	@echo "agent_configs — make targets:"
	@echo "  install    symlink shared config into place; seed per-host files if absent"
	@echo "  status     show each managed path's state"
	@echo "  uninstall  remove the symlinks we created (restore .bak); leaves seeds"
	@echo "  doctor     check no secret/per-host file is tracked; list missing seeds"
	@echo "Repo: $(REPO)"

install:
	@$(ROWS) | while read -r type src dst mode; do \
	  s="$(REPO)/$$src"; d="$(HOME)/$$dst"; \
	  if [ ! -e "$$s" ]; then echo "MISS src  $$src (skipping)"; continue; fi; \
	  case "$$type" in \
	    link) \
	      mkdir -p "$$(dirname "$$d")"; \
	      if [ -L "$$d" ]; then \
	        if [ "$$(readlink "$$d")" = "$$s" ]; then echo "ok     $$dst"; continue; fi; \
	        rm "$$d"; \
	      elif [ -e "$$d" ]; then \
	        if [ -e "$$d.bak" ]; then echo "WARN   $$dst is a real file and $$dst.bak exists; skipping"; continue; fi; \
	        mv "$$d" "$$d.bak"; echo "backup $$dst -> $$dst.bak"; \
	      fi; \
	      ln -s "$$s" "$$d"; echo "link   $$dst"; ;; \
	    linkkids) \
	      if [ -L "$$d" ]; then rm "$$d"; fi; \
	      mkdir -p "$$d"; \
	      for c in "$$s"/*; do \
	        [ -e "$$c" ] || continue; \
	        n="$$(basename "$$c")"; cd_="$$d/$$n"; \
	        if [ -L "$$cd_" ]; then \
	          if [ "$$(readlink "$$cd_")" = "$$c" ]; then echo "ok     $$dst/$$n"; continue; fi; \
	          rm "$$cd_"; \
	        elif [ -e "$$cd_" ]; then \
	          if [ -e "$$cd_.bak" ]; then echo "WARN   $$dst/$$n is a real file and .bak exists; skipping"; continue; fi; \
	          mv "$$cd_" "$$cd_.bak"; echo "backup $$dst/$$n -> $$dst/$$n.bak"; \
	        fi; \
	        ln -s "$$c" "$$cd_"; echo "link   $$dst/$$n"; \
	      done; \
	      for l in "$$d"/*; do \
	        [ -L "$$l" ] || continue; \
	        t="$$(readlink "$$l")"; \
	        case "$$t" in "$$s"/*) [ -e "$$t" ] || { rm "$$l"; echo "prune  $$dst/$$(basename "$$l") (removed from repo)"; }; ;; esac; \
	      done; ;; \
	    seed) \
	      if [ -e "$$d" ]; then echo "keep   $$dst (already present)"; continue; fi; \
	      mkdir -p "$$(dirname "$$d")"; cp "$$s" "$$d"; \
	      [ -n "$$mode" ] && chmod "$$mode" "$$d"; \
	      echo "seed   $$dst (from $$src)"; ;; \
	  esac; \
	done

status:
	@$(ROWS) | while read -r type src dst mode; do \
	  s="$(REPO)/$$src"; d="$(HOME)/$$dst"; \
	  if [ "$$type" = link ]; then \
	    if [ -L "$$d" ] && [ "$$(readlink "$$d")" = "$$s" ]; then st="ok-link"; \
	    elif [ -L "$$d" ]; then st="WRONG-LINK -> $$(readlink "$$d")"; \
	    elif [ -e "$$d" ]; then st="NOT-A-LINK (real file)"; \
	    else st="missing"; fi; \
	  elif [ "$$type" = linkkids ]; then \
	    if [ -L "$$d" ]; then st="IS-A-LINK (run: make install)"; \
	    elif [ ! -d "$$d" ]; then st="missing"; \
	    else \
	      ok=0; miss=0; loc=0; \
	      for c in "$$s"/*; do [ -e "$$c" ] || continue; \
	        if [ -L "$$d/$$(basename "$$c")" ] && [ "$$(readlink "$$d/$$(basename "$$c")")" = "$$c" ]; then ok=$$((ok+1)); else miss=$$((miss+1)); fi; done; \
	      for l in "$$d"/*; do [ -e "$$l" ] && [ ! -L "$$l" ] && loc=$$((loc+1)); done; \
	      st="kids: $$ok linked, $$miss unlinked, $$loc local"; \
	    fi; \
	  else \
	    if [ -e "$$d" ]; then st="seeded"; else st="absent (run: make install)"; fi; \
	  fi; \
	  printf '  %-5s %-44s %s\n' "$$type" "$$dst" "$$st"; \
	done

uninstall:
	@$(ROWS) | while read -r type src dst mode; do \
	  s="$(REPO)/$$src"; d="$(HOME)/$$dst"; \
	  case "$$type" in \
	    link) \
	      if [ -L "$$d" ] && [ "$$(readlink "$$d")" = "$$s" ]; then \
	        rm "$$d"; echo "unlink  $$dst"; \
	        if [ -e "$$d.bak" ]; then mv "$$d.bak" "$$d"; echo "restore $$dst"; fi; \
	      fi; ;; \
	    linkkids) \
	      [ -d "$$d" ] || continue; \
	      for l in "$$d"/*; do \
	        [ -L "$$l" ] || continue; \
	        case "$$(readlink "$$l")" in "$$s"/*) rm "$$l"; echo "unlink  $$dst/$$(basename "$$l")"; ;; esac; \
	      done; ;; \
	  esac; \
	done

doctor:
	@echo "== tracked-secret check (should be clean) =="
	@if git -C "$(REPO)" ls-files | grep -E '(^|/)(auth\.json|models\.json|models\.yml|\.credentials\.json|\.env)$$|\.(key|pem)$$'; then \
	  echo "  !! the files above are tracked but should NOT be — fix .gitignore / git rm --cached"; \
	else echo "  clean: no secret/per-host files are tracked"; fi
	@echo "== per-host seed files present? =="
	@$(ROWS) | awk '$$1=="seed"' | while read -r type src dst mode; do \
	  d="$(HOME)/$$dst"; [ -e "$$d" ] && echo "  ok    $$dst" || echo "  MISS  $$dst  (seed: make install)"; done
