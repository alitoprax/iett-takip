import urllib.request
import xml.etree.ElementTree as ET

url = 'https://api.ibb.gov.tr/iett/FiloDurum/SeferGerceklesme.asmx?WSDL'
try:
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req) as resp:
        xml_data = resp.read()
    root = ET.fromstring(xml_data)
    for child in root.iter():
        if '}operation' in child.tag and 'name' in child.attrib:
            print(child.attrib['name'])
except Exception as e:
    print('Failed:', e)
