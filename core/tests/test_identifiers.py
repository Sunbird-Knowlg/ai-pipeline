from sunbird_ai_core.identifiers import generate_identifier


def test_identifier_has_domain_prefix():
    assert generate_identifier("domain").startswith("do_")


def test_identifier_is_unique_across_calls():
    ids = {generate_identifier() for _ in range(20)}
    assert len(ids) == 20


def test_short_graph_id_used_as_is():
    assert generate_identifier("x").startswith("x_")
