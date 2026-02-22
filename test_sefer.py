import urllib.request
import xml.etree.ElementTree as ET
import json

url = 'https://api.ibb.gov.tr/iett/UlasimAnaVeri/PlanlananSeferSaati.asmx'
xml_body = '''<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <GetPlanlananSeferSaati_json xmlns="http://tempuri.org/"><HatKodu>36ES</HatKodu></GetPlanlananSeferSaati_json>
  </soap:Body>
</soap:Envelope>'''

try:
    req = urllib.request.Request(url, data=xml_body.encode('utf-8'))
    req.add_header('Content-Type', 'text/xml; charset=utf-8')
    req.add_header('SOAPAction', 'http://tempuri.org/GetPlanlananSeferSaati_json')
    with urllib.request.urlopen(req) as resp:
        xml_res = resp.read()
        
    root = ET.fromstring(xml_res)
    for elem in root.iter():
        if '}GetPlanlananSeferSaati_jsonResult' in elem.tag:
            result_str = elem.text
            if result_str:
                data = json.loads(result_str)
                print(json.dumps(data[:5], indent=2, ensure_ascii=False))
                break
except Exception as e:
    print('Error:', e)
