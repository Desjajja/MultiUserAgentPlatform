#!/usr/bin/env python3
"""
Semantic Scholar Search — no API key required

Usage:
    python3 search.py "perovskite solar cell" [--max 10] [--year 2023-] [--field chemistry] [--json]
    python3 search.py "CO2 capture" --year 2022-2024 --max 20
    python3 search.py "lithium battery" --open-access --json

Fields (--field):
    chemistry, biology, medicine, materials-science, environmental-science,
    engineering, physics, computer-science
"""

import argparse
import json
import sys
import time
import urllib.parse
import urllib.request


BASE_URL = "https://api.semanticscholar.org/graph/v1"

FIELDS = "title,authors,year,abstract,citationCount,openAccessPdf,externalIds,publicationTypes,journal"


def search(query: str, max_results: int = 10, year: str = None,
           field: str = None, open_access: bool = False, output_json: bool = False):

    params = {
        "query": query,
        "limit": min(max_results, 100),
        "fields": FIELDS,
    }
    if year:
        params["year"] = year
    if field:
        params["fieldsOfStudy"] = field
    if open_access:
        params["openAccessPdf"] = ""

    url = f"{BASE_URL}/paper/search?" + urllib.parse.urlencode(params)

    req = urllib.request.Request(url, headers={"User-Agent": "openclaw-research/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    papers = data.get("data", [])
    if not papers:
        print("No results found.", file=sys.stderr)
        sys.exit(1)

    results = []
    for p in papers:
        authors = [a.get("name", "") for a in p.get("authors", [])[:3]]
        author_str = ", ".join(authors)
        if len(p.get("authors", [])) > 3:
            author_str += " et al."

        pdf_url = ""
        oa = p.get("openAccessPdf")
        if oa:
            pdf_url = oa.get("url", "")

        doi = p.get("externalIds", {}).get("DOI", "")

        results.append({
            "title": p.get("title", ""),
            "authors": author_str,
            "year": p.get("year", ""),
            "journal": (p.get("journal") or {}).get("name", ""),
            "citations": p.get("citationCount", 0),
            "abstract": (p.get("abstract") or "")[:300],
            "pdf": pdf_url,
            "doi": doi,
            "s2_id": p.get("paperId", ""),
        })

    if output_json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
        return

    for i, r in enumerate(results, 1):
        print(f"{i}. [{r['year']}] {r['title']}")
        print(f"   {r['authors']}")
        if r["journal"]:
            print(f"   📄 {r['journal']}  |  引用: {r['citations']}")
        if r["abstract"]:
            print(f"   {r['abstract']}...")
        if r["pdf"]:
            print(f"   🔓 PDF: {r['pdf']}")
        elif r["doi"]:
            print(f"   DOI: https://doi.org/{r['doi']}")
        print()


def get_paper(paper_id: str, output_json: bool = False):
    """Get details for a specific paper by S2 ID or DOI."""
    url = f"{BASE_URL}/paper/{urllib.parse.quote(paper_id)}?fields={FIELDS},references,citations"
    req = urllib.request.Request(url, headers={"User-Agent": "openclaw-research/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            p = json.loads(resp.read().decode())
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    if output_json:
        print(json.dumps(p, ensure_ascii=False, indent=2))
        return

    authors = [a.get("name", "") for a in p.get("authors", [])[:5]]
    print(f"标题: {p.get('title')}")
    print(f"作者: {', '.join(authors)}")
    print(f"年份: {p.get('year')}  引用数: {p.get('citationCount')}")
    journal = (p.get("journal") or {}).get("name", "")
    if journal:
        print(f"期刊: {journal}")
    oa = p.get("openAccessPdf")
    if oa:
        print(f"PDF:  {oa.get('url')}")
    doi = p.get("externalIds", {}).get("DOI", "")
    if doi:
        print(f"DOI:  https://doi.org/{doi}")
    abstract = p.get("abstract") or ""
    if abstract:
        print(f"\n摘要:\n{abstract}")


def main():
    parser = argparse.ArgumentParser(description="Semantic Scholar paper search")
    sub = parser.add_subparsers(dest="cmd")

    s = sub.add_parser("search", help="Search papers")
    s.add_argument("query")
    s.add_argument("--max", type=int, default=10, metavar="N")
    s.add_argument("--year", help="Year range, e.g. 2020- or 2018-2023")
    s.add_argument("--field", help="Field of study filter")
    s.add_argument("--open-access", action="store_true")
    s.add_argument("--json", action="store_true", dest="output_json")

    g = sub.add_parser("get", help="Get paper details by S2 ID or DOI")
    g.add_argument("paper_id")
    g.add_argument("--json", action="store_true", dest="output_json")

    # default to search if no subcommand
    args, remaining = parser.parse_known_args()
    if args.cmd is None:
        args = s.parse_args(sys.argv[1:])
        args.cmd = "search"

    if args.cmd == "search":
        search(args.query, max_results=args.max, year=args.year,
               field=args.field, open_access=args.open_access,
               output_json=args.output_json)
    elif args.cmd == "get":
        get_paper(args.paper_id, output_json=args.output_json)


if __name__ == "__main__":
    main()
