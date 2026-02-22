import urllib.request, json, html as H
url = 'https://api.ibb.gov.tr/iett/UlasimAnaVeri/HatDurakGuzergah.asmx'
body = b'<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetDuraktanGecenHatlar_json xmlns="http://tempuri.org/"><DurakKodu>133691</DurakKodu></GetDuraktanGecenHatlar_json></soap:Body></soap:Envelope>'
req = urllib.request.Request(url, data=body, headers={
    'Content-Type': 'text/xml; charset=utf-8',
    'SOAPAction': '"http://tempuri.org/GetDuraktanGecenHatlar_json"',
    'User-Agent': 'Mozilla/5.0',
})
try:
    resp = urllib.request.urlopen(req, timeout=10).read().decode()
    tag = 'GetDuraktanGecenHatlar_jsonResult'
    si = resp.find('<' + tag + '>')
    if si > 0:
        si += len(tag) + 2
        ei = resp.find('</' + tag + '>', si)
        payload = H.unescape(resp[si:ei])
        print("Success:", payload[:500])
    else:
        print("Tag not found in response:", resp[:200])
except Exception as e:
    print(f'Error: {e}')
