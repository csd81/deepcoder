After an access token is refreshed, requests keep failing with 401s until the
process is restarted. It looks like a refresh updates the stored token, but the
very next request still goes out with the old token in the Authorization header.

Once a token has been refreshed, the next request should use the new token. Please
add a regression test covering this.
